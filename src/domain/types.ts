export type ClaimType = 'independent' | 'dependent';
export type DependencyType = 'none' | 'single' | 'multiple_alternative' | 'multiple_simultaneous';

export interface ClaimInput {
  number: number;
  type: ClaimType;
  dependency_type?: DependencyType;
  parent_numbers?: number[];
  features: string[];
  optional?: boolean;
}

export interface Claim extends ClaimInput {
  id: string;
  application_id: string;
}

export interface ApplicationInput {
  external_id: string;
  title: string;
  filing_date: string;
  priority_date?: string;
  claims: ClaimInput[];
}

export interface ApplicationRecord {
  id: string;
  external_id: string;
  title: string;
  filing_date: string;
  priority_date: string;
  created_at: string;
}

export interface ApplicationBundle extends ApplicationRecord {
  claims: Claim[];
}

export interface DictionaryFeature {
  code: string;
  name: string;
}

export interface EquivalenceInput {
  code_a: string;
  code_b: string;
  relation?: string;
}

export interface DictionaryInput {
  external_id: string;
  version_label: string;
  note?: string;
  features: DictionaryFeature[];
  equivalences?: EquivalenceInput[];
  mutex?: { code_a: string; code_b: string }[];
}

export interface DictionaryRecord {
  id: string;
  external_id: string;
  version_label: string;
  note: string | null;
  created_at: string;
}

export interface DictionaryBundle extends DictionaryRecord {
  features: DictionaryFeature[];
  equivalences: { code_a: string; code_b: string; relation: string }[];
  mutex: { code_a: string; code_b: string }[];
}

export interface ReferenceInput {
  external_id: string;
  title: string;
  publication_date: string;
  features: string[];
}

export interface ReferenceRecord {
  id: string;
  external_id: string;
  title: string;
  publication_date: string;
  created_at: string;
}

export interface ReferenceBundle extends ReferenceRecord {
  features: string[];
}

export interface Pagination {
  page: number;
  page_size: number;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}
