export class LocalOfficeFiles {
  constructor(root: string, state: string);
  root: string;
  state: string;
  opened: Set<string>;
  input(path: string): Promise<string>;
  output(path: string, internal?: boolean): Promise<{ staged: string; target: string }>;
  publish(staged: string, target: string): Promise<string>;
  own(id: unknown): void;
  assertEditor(id: string): void;
}
