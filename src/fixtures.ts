import type { ApplicationInput, DictionaryInput, ReferenceInput } from './domain/types.ts';

/**
 * Completely fictional fixtures. No real patents, no real literature, no real
 * technical standards. Codes (F1..F8) are arbitrary labels.
 */

export function fixtureDictionaryV1(): DictionaryInput {
  return {
    external_id: 'dict-v1',
    version_label: 'v1',
    note: '虚构特征词典第 1 版',
    features: [
      { code: 'F1', name: '基座壳体' },
      { code: 'F2', name: '显示模块' },
      { code: 'F2B', name: '柔性显示模块' },
      { code: 'F3', name: '供电模块' },
      { code: 'F4', name: '无线通信模块' },
      { code: 'F5', name: '触控输入单元' },
      { code: 'F6', name: '物理键盘单元' },
      { code: 'F7', name: '指纹识别单元' },
      { code: 'F8', name: '加密芯片' },
    ],
    equivalences: [{ code_a: 'F2', code_b: 'F2B', relation: 'equivalent' }],
    mutex: [{ code_a: 'F5', code_b: 'F6' }],
  };
}

/**
 * v2 changes the F2B relation from "equivalent" to "related" (not confirmed
 * equivalence) and adds F2C. Analyses already pinned to v1 must still
 * reproduce with their v1 basis.
 */
export function fixtureDictionaryV2(): DictionaryInput {
  return {
    external_id: 'dict-v2',
    version_label: 'v2',
    note: '虚构特征词典第 2 版（修订 F2B 关系，新增 F2C）',
    features: [
      { code: 'F1', name: '基座壳体' },
      { code: 'F2', name: '显示模块' },
      { code: 'F2B', name: '柔性显示模块' },
      { code: 'F2C', name: '可折叠显示模块' },
      { code: 'F3', name: '供电模块' },
      { code: 'F4', name: '无线通信模块' },
      { code: 'F5', name: '触控输入单元' },
      { code: 'F6', name: '物理键盘单元' },
      { code: 'F7', name: '指纹识别单元' },
      { code: 'F8', name: '加密芯片' },
    ],
    equivalences: [
      { code_a: 'F2', code_b: 'F2B', relation: 'related' },
      { code_a: 'F2', code_b: 'F2C', relation: 'equivalent' },
    ],
    mutex: [{ code_a: 'F5', code_b: 'F6' }],
  };
}

export function fixtureApplication(): ApplicationInput {
  return {
    external_id: 'app-jia',
    title: '虚构专利申请甲（演示用）',
    filing_date: '2025-06-10',
    priority_date: '2025-06-01',
    claims: [
      // 1: independent
      { number: 1, type: 'independent', features: ['F1', 'F2', 'F3'] },
      // 2: single dependency on 1
      { number: 2, type: 'dependent', dependency_type: 'single', parent_numbers: [1], features: ['F4'] },
      // 3: multiple alternative (1 or 2) -> two branches
      { number: 3, type: 'dependent', dependency_type: 'multiple_alternative', parent_numbers: [1, 2], features: ['F5'] },
      // 4: multiple simultaneous (1 and 2) -> one merged branch
      { number: 4, type: 'dependent', dependency_type: 'multiple_simultaneous', parent_numbers: [1, 2], features: ['F7'] },
      // 5: multi-level dependency on 3 (inherits both branches of 3)
      { number: 5, type: 'dependent', dependency_type: 'single', parent_numbers: [3], features: ['F8'] },
    ],
  };
}

/**
 * A second fictional application with defective claim graph:
 * missing citation, cycle, and mutually exclusive features.
 * Used for citation checks and expansion findings.
 */
export function fixtureBrokenApplication(): ApplicationInput {
  return {
    external_id: 'app-bing',
    title: '虚构专利申请丙（带引用缺陷，演示用）',
    filing_date: '2025-06-10',
    priority_date: '2025-06-01',
    claims: [
      { number: 1, type: 'independent', features: ['F1', 'F2'] },
      // 2: missing citation (parent 99 does not exist)
      { number: 2, type: 'dependent', dependency_type: 'single', parent_numbers: [99], features: ['F4'] },
      // 3 <-> 4: cycle
      { number: 3, type: 'dependent', dependency_type: 'single', parent_numbers: [4], features: ['F4'] },
      { number: 4, type: 'dependent', dependency_type: 'single', parent_numbers: [3], features: ['F5'] },
      // 5: mutex features F5 + F6 in one claim
      { number: 5, type: 'independent', features: ['F5', 'F6'] },
    ],
  };
}

export function fixtureReferences(): ReferenceInput[] {
  return [
    {
      external_id: 'ref-d1',
      title: '虚构对比文献 D1（公开日 2025-05-15）',
      publication_date: '2025-05-15',
      features: ['F1', 'F2', 'F3', 'F4'],
    },
    {
      external_id: 'ref-d2',
      title: '虚构对比文献 D2（公开日 2025-05-20）',
      publication_date: '2025-05-20',
      features: ['F1', 'F2', 'F3', 'F5'],
    },
    {
      external_id: 'ref-d3',
      title: '虚构对比文献 D3（公开日 2025-06-01，与优先权同日）',
      publication_date: '2025-06-01',
      features: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'],
    },
    {
      external_id: 'ref-d4',
      title: '虚构对比文献 D4（公开日 2025-06-10，晚于优先权）',
      publication_date: '2025-06-10',
      features: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'],
    },
    {
      external_id: 'ref-d5',
      title: '虚构对比文献 D5（公开日 2025-05-10，仅披露 F1、F2）',
      publication_date: '2025-05-10',
      features: ['F1', 'F2'],
    },
    {
      external_id: 'ref-d6',
      title: '虚构对比文献 D6（公开日 2025-05-25，仅披露 F3、F4）',
      publication_date: '2025-05-25',
      features: ['F3', 'F4'],
    },
    {
      external_id: 'ref-d7',
      title: '虚构对比文献 D7（公开日 2025-05-12，披露等价特征 F2B）',
      publication_date: '2025-05-12',
      features: ['F1', 'F2B', 'F3', 'F4'],
    },
    {
      external_id: 'ref-d8',
      title: '虚构对比文献 D8（公开日 2025-05-18，含词典未收录特征 F999）',
      publication_date: '2025-05-18',
      features: ['F1', 'F2', 'F999'],
    },
  ];
}
