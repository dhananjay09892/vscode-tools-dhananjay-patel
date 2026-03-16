export type LayerName = string;

export interface ValidatorConfig {
  layers: Record<LayerName, string[]>;
  allowedImports: Record<LayerName, LayerName[]>;
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

export interface Violation {
  file: string;
  line: number;
  sourceLayer: string;
  targetLayer: string;
  importText: string;
  message: string;
}
