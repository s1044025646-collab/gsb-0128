import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, closeDb, migrate } from './db.ts';
import { migration001 } from './migrations/001_init.ts';
import { getTmpDir } from './paths.ts';
import { createDictionary, listDictionaries } from './domain/dictionary.ts';
import { createApplication, listApplications, getApplication } from './domain/applications.ts';
import { createReference, listReferences } from './domain/references.ts';
import { expandClaims, mutexKey } from './domain/expansion.ts';
import { createAnalysis, listAnalyses, loadAnalysis, reproduceAnalysis } from './domain/analysis.ts';
import { addReview } from './domain/reviews.ts';
import { buildReport } from './domain/report.ts';
import { writeFileSync } from 'node:fs';
import { fixtureApplication, fixtureBrokenApplication, fixtureDictionaryV1, fixtureDictionaryV2, fixtureReferences } from './fixtures.ts';

function section(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`);
}

function kv(label: string, value: unknown): void {
  process.stdout.write(`${label}: ${JSON.stringify(value)}\n`);
}

export async function runDemo(): Promise<void> {
  const demoDir = join(getTmpDir(), 'demo');
  rmSync(demoDir, { recursive: true, force: true });
  process.env.PATENT_DATA_DIR = demoDir;

  section('0. 初始化（全新临时数据目录，可重复运行）');
  const db = openDb(join(demoDir, 'patent.db'));
  migrate(db, [migration001]);
  kv('data_dir', demoDir);

  section('1. 导入虚构夹具（词典 v1、申请甲、申请丙、8 篇对比文献）');
  kv('词典 v1 导入前数量', listDictionaries().length);
  const dict1 = createDictionary(fixtureDictionaryV1());
  kv('词典 v1 导入后数量', listDictionaries().length);
  kv('申请导入前数量', listApplications().length);
  const app = createApplication(fixtureApplication());
  const appBing = createApplication(fixtureBrokenApplication());
  kv('申请导入后数量', listApplications().length);
  for (const ref of fixtureReferences()) createReference(ref);
  kv('文献导入后数量', listReferences().length);

  section('2. 引用关系检查（循环 / 不存在的引用）');
  const brokenBundle = getApplication(appBing.record.id);
  const citationCheck = expandClaims(brokenBundle.claims, new Set());
  kv('findings', citationCheck.findings);
  const brokenExpansion = expandClaims(
    brokenBundle.claims,
    new Set(dict1.record.mutex.map((m) => mutexKey(m.code_a, m.code_b))),
  );
  kv('申请丙展开分支（含互斥标记）', brokenExpansion.branches.map((b) => ({ claim: b.claim_number, issues: b.issues })));

  section('3. 展开从属权利要求（保留任选/同时依赖分支）');
  const appBundle = getApplication(app.record.id);
  const mutexPairs = new Set(dict1.record.mutex.map((m) => mutexKey(m.code_a, m.code_b)));
  const expansion = expandClaims(appBundle.claims, mutexPairs);
  kv('展开分支总数', expansion.branches.length);
  for (const b of expansion.branches) {
    kv(`  分支 #${b.index} (权项 ${b.claim_number})`, {
      path: b.path,
      features: b.features.map((f) => `${f.code}(来自权项${f.introduced_by})`),
      issues: b.issues,
    });
  }

  section('4. 结构化覆盖检查（有效日 = 优先权日 2025-06-01）');
  const analysis = createAnalysis({
    application_id: app.record.id,
    dictionary_id: dict1.record.id,
    note: 'demo run with dictionary v1',
  });
  kv('analysis_id', analysis.run.id);
  kv('basis_hash', analysis.run.basis_hash);
  kv('有效日', analysis.run.effective_date);
  for (const ref of analysis.references) {
    for (const br of ref.branch_results) {
      kv(
        `  ${ref.external_id} (${ref.publication_date}, ${ref.reason}) 分支#${br.branch_index}/权项${analysis.branches.find((b) => b.index === br.branch_index)?.claim_number ?? '?'}`,
        br.fully_covered
          ? '完全覆盖'
          : `未覆盖: 披露${br.disclosed_count} 缺失${br.missing_count} 待复核${br.review_count}`,
      );
    }
  }

  section('5. 人工复核结论入库');
  const review = addReview(analysis.run.id, {
    reviewer: 'demo-reviewer',
    branch_index: 1,
    reference_id: analysis.references[0]!.reference_id,
    feature_code: 'F4',
    conclusion: 'confirmed_missing',
    note: '演示用复核结论',
  });
  kv('review', { id: review.id, conclusion: review.conclusion });

  section('6. 导出报告');
  const report = buildReport(analysis.run.id);
  const reportPath = join(getTmpDir(), 'demo-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  kv('report_path', reportPath);
  kv('report_type', report.report_type);

  section('7. 词典升级到 v2 后形成新分析，旧依据保留');
  const dict2 = createDictionary(fixtureDictionaryV2());
  kv('词典版本数', listDictionaries().length);
  const analysis2 = createAnalysis({
    application_id: app.record.id,
    dictionary_id: dict2.record.id,
    note: 'demo run with dictionary v2',
  });
  kv('新 analysis_id', analysis2.run.id);
  kv('新 basis_hash', analysis2.run.basis_hash);
  const reproduced = reproduceAnalysis(analysis.run.id);
  kv('旧分析复现结果', reproduced);
  kv('旧分析结果未变化', reproduced.match);

  section('8. 重复提交幂等性');
  const appAgain = createApplication(fixtureApplication());
  kv('重复导入申请 duplicate', appAgain.duplicate);
  const dictAgain = createDictionary(fixtureDictionaryV1());
  kv('重复导入词典 duplicate', dictAgain.duplicate);

  section('9. 持久化检查（关闭后重开）');
  closeDb();
  openDb(join(demoDir, 'patent.db'));
  kv('重开后 analysis 数量', listAnalyses().length);
  kv('重开后申请数量', listApplications().length);

  section('演示完成');
  kv('数据目录', demoDir);
}
