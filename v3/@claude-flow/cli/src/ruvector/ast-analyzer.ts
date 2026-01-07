/**
 * AST Analyzer - Wrapper for ruvector's AST parsing capabilities
 *
 * Provides code analysis features:
 * - Symbol extraction (functions, classes, variables)
 * - Cyclomatic complexity scoring
 * - Code structure analysis
 * - Graceful fallback when ruvector not installed
 *
 * Created with ruv.io
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// Type definitions matching ruvector's API
export interface FunctionInfo {
  name: string;
  params: string[];
  returnType?: string;
  async: boolean;
  exported: boolean;
  startLine: number;
  endLine: number;
  complexity: number;
  calls: string[];
}

export interface ClassInfo {
  name: string;
  extends?: string;
  implements: string[];
  methods: FunctionInfo[];
  properties: string[];
  exported: boolean;
  startLine: number;
  endLine: number;
}

export interface ImportInfo {
  source: string;
  default?: string;
  named: string[];
  namespace?: string;
  type: 'esm' | 'commonjs' | 'dynamic';
}

export interface ExportInfo {
  name: string;
  type: 'default' | 'named' | 'all';
  source?: string;
}

export interface FileAnalysis {
  file: string;
  language: string;
  imports: ImportInfo[];
  exports: ExportInfo[];
  functions: FunctionInfo[];
  classes: ClassInfo[];
  variables: string[];
  types: string[];
  complexity: number;
  lines: number;
  parseTime: number;
}

export interface ComplexityResult {
  file: string;
  lines: number;
  nonEmptyLines: number;
  cyclomaticComplexity: number;
  functions: number;
  avgFunctionSize: number;
  maxFunctionComplexity?: number;
}

export interface ASTAnalyzerOptions {
  includeComplexity?: boolean;
  recursive?: boolean;
  extensions?: string[];
  maxFiles?: number;
}

// Check if ruvector is available
let ruvectorModule: any = null;
let ruvectorAvailable = false;

async function loadRuvector(): Promise<boolean> {
  if (ruvectorModule !== null) {
    return ruvectorAvailable;
  }

  try {
    ruvectorModule = await import('ruvector');
    ruvectorAvailable = true;
    return true;
  } catch {
    ruvectorModule = {};
    ruvectorAvailable = false;
    return false;
  }
}

/**
 * Check if ruvector is available
 */
export async function isRuvectorAvailable(): Promise<boolean> {
  return loadRuvector();
}

/**
 * Get complexity rating from score
 */
export function getComplexityRating(complexity: number): 'low' | 'medium' | 'high' | 'critical' {
  if (complexity <= 10) return 'low';
  if (complexity <= 20) return 'medium';
  if (complexity <= 30) return 'high';
  return 'critical';
}

/**
 * Detect language from file extension
 */
export function detectLanguage(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const languageMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
  };
  return languageMap[ext] || 'unknown';
}

/**
 * Analyze a single file using ruvector's AST parser
 */
export async function analyzeFile(
  filePath: string,
  options: ASTAnalyzerOptions = {}
): Promise<FileAnalysis | null> {
  const available = await loadRuvector();

  if (available && ruvectorModule.CodeParser) {
    try {
      const parser = ruvectorModule.getCodeParser?.() ?? new ruvectorModule.CodeParser();
      await parser.init();
      return await parser.analyze(filePath);
    } catch (error) {
      // Fall through to fallback
    }
  }

  // Fallback: regex-based analysis
  return await analyzeFileWithFallback(filePath);
}

/**
 * Analyze complexity of a single file
 */
export async function analyzeComplexity(
  filePath: string
): Promise<ComplexityResult | null> {
  const available = await loadRuvector();

  if (available && ruvectorModule.analyzeFile) {
    try {
      return ruvectorModule.analyzeFile(filePath);
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: simple complexity analysis
  return await analyzeComplexityWithFallback(filePath);
}

/**
 * Analyze multiple files
 */
export async function analyzeFiles(
  files: string[],
  options: ASTAnalyzerOptions = {}
): Promise<FileAnalysis[]> {
  const maxFiles = options.maxFiles ?? 100;
  const filesToAnalyze = files.slice(0, maxFiles);
  const results: FileAnalysis[] = [];

  for (const file of filesToAnalyze) {
    try {
      const result = await analyzeFile(file, options);
      if (result) {
        results.push(result);
      }
    } catch {
      // Skip files that fail to analyze
    }
  }

  return results;
}

/**
 * Analyze complexity for multiple files
 */
export async function analyzeFilesComplexity(
  files: string[],
  options: ASTAnalyzerOptions = {}
): Promise<ComplexityResult[]> {
  const maxFiles = options.maxFiles ?? 100;
  const filesToAnalyze = files.slice(0, maxFiles);
  const results: ComplexityResult[] = [];

  for (const file of filesToAnalyze) {
    try {
      const result = await analyzeComplexity(file);
      if (result) {
        results.push(result);
      }
    } catch {
      // Skip files that fail to analyze
    }
  }

  return results;
}

/**
 * Get all symbols from a file
 */
export async function getSymbols(filePath: string): Promise<string[]> {
  const available = await loadRuvector();

  if (available && ruvectorModule.CodeParser) {
    try {
      const parser = ruvectorModule.getCodeParser?.() ?? new ruvectorModule.CodeParser();
      await parser.init();
      return await parser.getSymbols(filePath);
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: extract symbols with regex
  const analysis = await analyzeFileWithFallback(filePath);
  if (!analysis) return [];

  return [
    ...analysis.functions.map(f => f.name),
    ...analysis.classes.map(c => c.name),
    ...analysis.variables,
    ...analysis.types,
  ];
}

/**
 * Scan directory for analyzable files
 */
export async function scanDirectory(
  dirPath: string,
  options: ASTAnalyzerOptions = {}
): Promise<string[]> {
  const extensions = options.extensions ?? ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go'];
  const files: string[] = [];

  async function scan(dir: string, depth: number = 0): Promise<void> {
    if (depth > 10) return; // Max depth protection

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip common directories
        if (entry.isDirectory()) {
          if (!['node_modules', '.git', 'dist', 'build', '.next', '__pycache__'].includes(entry.name)) {
            if (options.recursive !== false) {
              await scan(fullPath, depth + 1);
            }
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  await scan(dirPath);
  return files;
}

// ============================================
// Fallback Implementations
// ============================================

/**
 * Fallback file analysis using regex
 */
async function analyzeFileWithFallback(filePath: string): Promise<FileAnalysis | null> {
  const startTime = Date.now();

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const language = detectLanguage(filePath);

    const analysis: FileAnalysis = {
      file: filePath,
      language,
      imports: extractImports(content, language),
      exports: extractExports(content, language),
      functions: extractFunctions(content, language),
      classes: extractClasses(content, language),
      variables: extractVariables(content, language),
      types: extractTypes(content, language),
      complexity: calculateComplexity(content),
      lines: lines.length,
      parseTime: Date.now() - startTime,
    };

    return analysis;
  } catch {
    return null;
  }
}

/**
 * Fallback complexity analysis
 */
async function analyzeComplexityWithFallback(filePath: string): Promise<ComplexityResult | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const nonEmptyLines = lines.filter(l => l.trim().length > 0).length;

    const functionMatches = content.match(/function\s+\w+|(?:async\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(/g);
    const functions = functionMatches?.length ?? 0;

    return {
      file: filePath,
      lines: lines.length,
      nonEmptyLines,
      cyclomaticComplexity: calculateComplexity(content),
      functions,
      avgFunctionSize: functions > 0 ? Math.round(nonEmptyLines / functions) : nonEmptyLines,
      maxFunctionComplexity: undefined, // Not available in fallback
    };
  } catch {
    return null;
  }
}

function extractImports(content: string, language: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  if (language === 'typescript' || language === 'javascript') {
    // ES imports
    const esmRegex = /import\s+(?:(?:(\w+)\s*,?\s*)?(?:\{([^}]+)\})?(?:\*\s+as\s+(\w+))?\s+from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = esmRegex.exec(content)) !== null) {
      imports.push({
        source: match[4],
        default: match[1],
        named: match[2] ? match[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0]) : [],
        namespace: match[3],
        type: 'esm',
      });
    }

    // CommonJS require
    const cjsRegex = /(?:const|let|var)\s+(?:(\w+)|(\{[^}]+\}))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = cjsRegex.exec(content)) !== null) {
      imports.push({
        source: match[3],
        default: match[1],
        named: match[2] ? match[2].replace(/[{}]/g, '').split(',').map(s => s.trim()) : [],
        type: 'commonjs',
      });
    }
  } else if (language === 'python') {
    // Python imports
    const pyImportRegex = /(?:from\s+(\S+)\s+)?import\s+([^#\n]+)/g;
    let match;
    while ((match = pyImportRegex.exec(content)) !== null) {
      imports.push({
        source: match[1] || match[2].split(',')[0].trim(),
        named: match[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0]),
        type: 'esm',
      });
    }
  }

  return imports;
}

function extractExports(content: string, language: string): ExportInfo[] {
  const exports: ExportInfo[] = [];

  if (language === 'typescript' || language === 'javascript') {
    // Export default
    const defaultRegex = /export\s+default\s+(?:class|function|const|let|var)?\s*(\w+)?/g;
    let match;
    while ((match = defaultRegex.exec(content)) !== null) {
      exports.push({ name: match[1] || 'default', type: 'default' });
    }

    // Named exports
    const namedRegex = /export\s+(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/g;
    while ((match = namedRegex.exec(content)) !== null) {
      exports.push({ name: match[1], type: 'named' });
    }

    // Export all
    const allRegex = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g;
    while ((match = allRegex.exec(content)) !== null) {
      exports.push({ name: '*', type: 'all', source: match[1] });
    }
  }

  return exports;
}

function extractFunctions(content: string, language: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const lines = content.split('\n');

  if (language === 'typescript' || language === 'javascript') {
    // Function declarations and expressions
    const funcRegex = /(?:export\s+)?(async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>|\w+\s*=>))/g;
    let match;
    while ((match = funcRegex.exec(content)) !== null) {
      const name = match[2] || match[3];
      if (name) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        functions.push({
          name,
          params: [],
          async: !!match[1],
          exported: content.substring(Math.max(0, match.index - 10), match.index).includes('export'),
          startLine: lineNum,
          endLine: lineNum + 10, // Approximate
          complexity: 1,
          calls: [],
        });
      }
    }
  } else if (language === 'python') {
    const pyFuncRegex = /(async\s+)?def\s+(\w+)\s*\(/g;
    let match;
    while ((match = pyFuncRegex.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      functions.push({
        name: match[2],
        params: [],
        async: !!match[1],
        exported: true,
        startLine: lineNum,
        endLine: lineNum + 10,
        complexity: 1,
        calls: [],
      });
    }
  }

  return functions;
}

function extractClasses(content: string, language: string): ClassInfo[] {
  const classes: ClassInfo[] = [];

  if (language === 'typescript' || language === 'javascript') {
    const classRegex = /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/g;
    let match;
    while ((match = classRegex.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      classes.push({
        name: match[1],
        extends: match[2],
        implements: match[3] ? match[3].split(',').map(s => s.trim()) : [],
        methods: [],
        properties: [],
        exported: content.substring(Math.max(0, match.index - 10), match.index).includes('export'),
        startLine: lineNum,
        endLine: lineNum + 20,
      });
    }
  } else if (language === 'python') {
    const pyClassRegex = /class\s+(\w+)(?:\s*\(([^)]*)\))?/g;
    let match;
    while ((match = pyClassRegex.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      classes.push({
        name: match[1],
        extends: match[2]?.split(',')[0]?.trim(),
        implements: [],
        methods: [],
        properties: [],
        exported: true,
        startLine: lineNum,
        endLine: lineNum + 20,
      });
    }
  }

  return classes;
}

function extractVariables(content: string, language: string): string[] {
  const variables: string[] = [];

  if (language === 'typescript' || language === 'javascript') {
    // Top-level const/let/var (not in functions)
    const varRegex = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[=:]/gm;
    let match;
    while ((match = varRegex.exec(content)) !== null) {
      // Skip if it looks like a function
      const afterMatch = content.substring(match.index, match.index + 200);
      if (!afterMatch.includes('=>') && !afterMatch.includes('function')) {
        variables.push(match[1]);
      }
    }
  }

  return variables;
}

function extractTypes(content: string, language: string): string[] {
  const types: string[] = [];

  if (language === 'typescript') {
    // Interfaces
    const interfaceRegex = /(?:export\s+)?interface\s+(\w+)/g;
    let match;
    while ((match = interfaceRegex.exec(content)) !== null) {
      types.push(match[1]);
    }

    // Type aliases
    const typeRegex = /(?:export\s+)?type\s+(\w+)\s*[=<]/g;
    while ((match = typeRegex.exec(content)) !== null) {
      types.push(match[1]);
    }

    // Enums
    const enumRegex = /(?:export\s+)?(?:const\s+)?enum\s+(\w+)/g;
    while ((match = enumRegex.exec(content)) !== null) {
      types.push(match[1]);
    }
  }

  return types;
}

function calculateComplexity(content: string): number {
  // Simple cyclomatic complexity calculation
  const conditions = [
    /\bif\s*\(/g,
    /\belse\s+if\s*\(/g,
    /\bfor\s*\(/g,
    /\bwhile\s*\(/g,
    /\bcase\s+/g,
    /\bcatch\s*\(/g,
    /\?\s*[^:]/g, // Ternary
    /&&/g,
    /\|\|/g,
    /\?\?/g, // Nullish coalescing
  ];

  let complexity = 1; // Base complexity

  for (const pattern of conditions) {
    const matches = content.match(pattern);
    if (matches) {
      complexity += matches.length;
    }
  }

  return complexity;
}

export default {
  isRuvectorAvailable,
  analyzeFile,
  analyzeFiles,
  analyzeComplexity,
  analyzeFilesComplexity,
  getSymbols,
  scanDirectory,
  getComplexityRating,
  detectLanguage,
};
