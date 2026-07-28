export interface OperationParam {
  name: string;
  in: string;
  required: boolean;
  type: string;
  description: string;
}

export interface OperationBody {
  mime?: string;
  required: boolean;
  schema: string;
}

export interface Operation {
  operationId: string;
  method: string;
  path: string;
  tags: string[];
  summary: string;
  description: string;
  params: OperationParam[];
  body?: OperationBody;
  mutating: boolean;
}

export interface Catalog {
  apiTitle: string;
  apiVersion: string;
  baseUrl: string;
  generatedFrom: string;
  operationCount: number;
  tags: string[];
  operations: Operation[];
}
