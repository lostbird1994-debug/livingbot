export function createVoiceProvider(kind: string, options?: any): any;
export function listVoiceCatalog(options?: any): any[];
export function serializeOpenAiCompatibleVoiceSecret(input: any, previous?: string, options?: any): string;
export function speakable(input: string): string;
export function toUtterances(input: string, options?: { maxChars?: number }): string[];

export function voiceModelDefaults(provider: string, secret: string): { ttsModel: string; sttModel: string; selectable: boolean };
export function discoverVoiceModels(provider: string, secret: string, signal: AbortSignal): Promise<{models: {id: string; label: string; synthesis?: boolean; transcription?: boolean}[]; supported: boolean}>;
