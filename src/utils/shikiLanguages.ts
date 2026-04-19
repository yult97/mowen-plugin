/**
 * Shiki 语言 ID 与别名映射模块
 *
 * 数据来源：https://shiki.style/languages
 * 用途：裁剪网页代码块时，从 HTML 属性中检测编程语言并映射为 Shiki 主 ID。
 * 此映射关系由裁剪插件独立维护，与墨问笔记端的映射关系分离。
 */

/**
 * Shiki 官方支持的全部语言主 ID 集合
 * 来源：https://shiki.style/languages  Bundled Languages 表格
 */
export const SHIKI_LANGUAGE_IDS: Set<string> = new Set([
  "abap", "actionscript-3", "ada", "angular-html", "angular-ts",
  "apache", "apex", "apl", "applescript", "ara", "asciidoc", "asm",
  "astro", "awk", "ballerina", "bat", "beancount", "berry", "bibtex",
  "bicep", "bird2", "blade", "bsl", "c", "c3", "cadence", "cairo",
  "clarity", "clojure", "cmake", "cobol", "codeowners", "codeql",
  "coffee", "common-lisp", "coq", "cpp", "crystal", "csharp", "css",
  "csv", "cue", "cypher", "d", "dart", "dax", "desktop", "diff",
  "docker", "dotenv", "dream-maker", "edge", "elixir", "elm",
  "emacs-lisp", "erb", "erlang", "fennel", "fish", "fluent",
  "fortran-fixed-form", "fortran-free-form", "fsharp", "gdresource",
  "gdscript", "gdshader", "genie", "gherkin", "git-commit",
  "git-rebase", "gleam", "glimmer-js", "glimmer-ts", "glsl", "gn",
  "gnuplot", "go", "graphql", "groovy", "hack", "haml", "handlebars",
  "haskell", "haxe", "hcl", "hjson", "hlsl", "html",
  "html-derivative", "http", "hurl", "hxml", "hy", "imba", "ini",
  "java", "javascript", "jinja", "jison", "json", "json5", "jsonc",
  "jsonl", "jsonnet", "jssm", "jsx", "julia", "just", "kdl", "kotlin",
  "kusto", "latex", "lean", "less", "liquid", "llvm", "log", "logo",
  "lua", "luau", "make", "markdown", "marko", "matlab", "mdc", "mdx",
  "mermaid", "mipsasm", "mojo", "moonbit", "move", "narrat",
  "nextflow", "nextflow-groovy", "nginx", "nim", "nix", "nushell",
  "objective-c", "objective-cpp", "ocaml", "odin", "openscad",
  "pascal", "perl", "php", "pkl", "plsql", "po", "polar", "postcss",
  "powerquery", "powershell", "prisma", "prolog", "proto", "pug",
  "puppet", "purescript", "python", "qml", "qmldir", "qss", "r",
  "racket", "raku", "razor", "reg", "regexp", "rel", "riscv", "ron",
  "rosmsg", "rst", "ruby", "rust", "sas", "sass", "scala", "scheme",
  "scss", "sdbl", "shaderlab", "shellscript", "shellsession",
  "smalltalk", "solidity", "soy", "sparql", "splunk", "sql",
  "ssh-config", "stata", "stylus", "surrealql", "svelte", "swift",
  "system-verilog", "systemd", "talonscript", "tasl", "tcl", "templ",
  "terraform", "tex", "toml", "ts-tags", "tsv", "tsx", "turtle",
  "twig", "typescript", "typespec", "typst", "v", "vala", "vb",
  "verilog", "vhdl", "viml", "vue", "vue-html", "vue-vine", "vyper",
  "wasm", "wenyan", "wgsl", "wikitext", "wit", "wolfram", "xml",
  "xsl", "yaml", "zenscript", "zig",
  // 特殊语言
  "text", "ansi",
]);

/**
 * 别名 → 主 ID 映射表
 * 来源：https://shiki.style/languages 中各语言行的 Alias 列
 * 另包含网页中常见的非标准别名（如 golang、plaintext 等）
 */
export const SHIKI_LANGUAGE_ALIASES: Record<string, string> = {
  // === shiki.style/languages 官方别名 ===
  "adoc": "asciidoc",
  "batch": "bat",
  "be": "berry",
  "bird": "bird2",
  "1c": "bsl",
  "cdc": "cadence",
  "clj": "clojure",
  "ql": "codeql",
  "coffeescript": "coffee",
  "lisp": "common-lisp",
  "c++": "cpp",
  "c#": "csharp",
  "cs": "csharp",
  "cql": "cypher",
  "dockerfile": "docker",
  "elisp": "emacs-lisp",
  "erl": "erlang",
  "ftl": "fluent",
  "f": "fortran-fixed-form",
  "for": "fortran-fixed-form",
  "f77": "fortran-fixed-form",
  "f90": "fortran-free-form",
  "f95": "fortran-free-form",
  "f03": "fortran-free-form",
  "f08": "fortran-free-form",
  "f18": "fortran-free-form",
  "f#": "fsharp",
  "fs": "fsharp",
  "tscn": "gdresource",
  "tres": "gdresource",
  "gd": "gdscript",
  "gjs": "glimmer-js",
  "gts": "glimmer-ts",
  "gql": "graphql",
  "hbs": "handlebars",
  "hs": "haskell",
  "properties": "ini",
  "js": "javascript",
  "cjs": "javascript",
  "mjs": "javascript",
  "fsl": "jssm",
  "jl": "julia",
  "kt": "kotlin",
  "kts": "kotlin",
  "kql": "kusto",
  "lean4": "lean",
  "makefile": "make",
  "md": "markdown",
  "mmd": "mermaid",
  "mips": "mipsasm",
  "mbt": "moonbit",
  "mbti": "moonbit",
  "nar": "narrat",
  "nf": "nextflow",
  "objc": "objective-c",
  "nu": "nushell",
  "scad": "openscad",
  "pot": "po",
  "potx": "po",
  "ps": "powershell",
  "ps1": "powershell",
  "protobuf": "proto",
  "jade": "pug",
  "py": "python",
  "perl6": "raku",
  "regex": "regexp",
  "rb": "ruby",
  "rs": "rust",
  "1c-query": "sdbl",
  "shader": "shaderlab",
  "bash": "shellscript",
  "sh": "shellscript",
  "shell": "shellscript",
  "zsh": "shellscript",
  "console": "shellsession",
  "closure-templates": "soy",
  "spl": "splunk",
  "styl": "stylus",
  "surql": "surrealql",
  "talon": "talonscript",
  "tf": "terraform",
  "tfvars": "terraform",
  "lit": "ts-tags",
  "ts": "typescript",
  "cts": "typescript",
  "mts": "typescript",
  "tsp": "typespec",
  "typ": "typst",
  "cmd": "vb",
  "vim": "viml",
  "vimscript": "viml",
  "vy": "vyper",
  "文言": "wenyan",
  "mediawiki": "wikitext",
  "wiki": "wikitext",
  "wl": "wolfram",
  "yml": "yaml",

  // === 网页中常见的非标准别名 ===
  "golang": "go",
  "python3": "python",
  "py3": "python",
  "python2": "python",
  "py2": "python",
  "node": "javascript",
  "nodejs": "javascript",
  "jscript": "javascript",
  "shell-session": "shellsession",
  "bash-session": "shellsession",
  "sh-session": "shellsession",
  "zsh-session": "shellsession",
  "terminal": "shellsession",
  "terminal-output": "shellsession",
  "cmdline": "shellsession",
  "env": "dotenv",
  "docker-compose": "yaml",
  "compose": "yaml",
  "postgres": "sql",
  "postgresql": "sql",
  "psql": "sql",
  "mysql": "sql",
  "sqlite": "sql",
  "conf": "ini",
  "cfg": "ini",
  "plist": "xml",
  "objectivec": "objective-c",
  "obj-c": "objective-c",
  "cxx": "cpp",
  "cc": "cpp",
  "hh": "cpp",
  "hpp": "cpp",
  "psm1": "powershell",
  "powershellscript": "powershell",
  "proto3": "proto",
  "plain": "text",
  "plaintext": "text",
  "txt": "text",
  "none": "text",
  "nohighlight": "text",
  "no-highlight": "text",
};

/**
 * 将原始语言标识解析为 Shiki 主 ID
 *
 * 查找顺序：别名表 → 主 ID 表
 * 均不命中时返回 null（调用方应保持 quote 类型）
 *
 * @param rawLang 从 HTML 属性中提取的原始语言标识（已小写化）
 * @returns Shiki 主 ID 或 null
 */
export function resolveShikiLanguageId(rawLang: string): string | null {
  const normalized = rawLang.toLowerCase().trim();
  if (!normalized) return null;

  // 优先查别名表
  if (SHIKI_LANGUAGE_ALIASES[normalized]) {
    return SHIKI_LANGUAGE_ALIASES[normalized];
  }
  // 再查主 ID 表
  if (SHIKI_LANGUAGE_IDS.has(normalized)) {
    return normalized;
  }
  // 未命中 → null（保持 quote）
  return null;
}

/**
 * 从 <pre> 和 <code> 的 HTML 属性字符串中检测编程语言
 *
 * 检测优先级：
 * 1. data-language / data-lang 属性
 * 2. class 中的 language-xxx / lang-xxx 前缀
 * 3. 高亮库 class（hljs + 语言名）
 * 4. 未检测到 → 返回 null
 *
 * @param preAttrs <pre> 标签的属性字符串（不含标签名）
 * @param codeAttrs <code> 标签的属性字符串（不含标签名），可为空
 * @returns Shiki 语言 ID 或 null
 */
export function detectCodeLanguage(preAttrs: string, codeAttrs: string): string | null {
  const allAttrs = preAttrs + ' ' + codeAttrs;
  let rawLang: string | null = null;

  // 优先级 1：data-language / data-lang 属性
  const dataLangMatch = allAttrs.match(/data-lang(?:uage)?=["']([^"']+)["']/i);
  if (dataLangMatch) {
    rawLang = dataLangMatch[1];
  }

  // 优先级 2：class="language-xxx" / "lang-xxx"
  if (!rawLang) {
    const classMatch = allAttrs.match(/class=["'][^"']*(?:language-|lang-)([\w+-]+)/i);
    if (classMatch) {
      rawLang = classMatch[1];
    }
  }

  // 优先级 3：高亮库 class（hljs + 语言名）
  if (!rawLang) {
    const hljsMatch = allAttrs.match(/class=["'][^"']*\bhljs\s+([\w+-]+)/i);
    if (hljsMatch) {
      rawLang = hljsMatch[1];
    }
  }

  // 未检测到任何语言标识
  if (!rawLang) return null;

  // 解析为 Shiki 主 ID（不在列表中 → null → 保持 quote）
  return resolveShikiLanguageId(rawLang);
}

export function inferCodeLanguageFromText(text: string): string | null {
  const sample = text.trim();
  if (!sample) {
    return null;
  }

  const lower = sample.toLowerCase();

  if (/^diff --git\b/m.test(lower) || /^@@\s+[-+]/m.test(sample) || /^(?:\+\+\+|---)\s+\S+/m.test(sample)) {
    return 'diff';
  }

  if (/^<\?php\b/i.test(sample)) {
    return 'php';
  }

  if (/\bfrom\s+[^\n]+\n(?:\s*\w+\s+.+\n)*(?:\s*run|cmd|entrypoint|copy|add|workdir|expose|env|arg|user|label|volume|healthcheck)\b/i.test(sample)
    || /^(?:from|run|cmd|entrypoint|copy|add|workdir|expose|env|arg|user|label|volume|healthcheck)\b/m.test(lower)) {
    return 'docker';
  }

  if (/\b(import\s+react\b|from\s+['"]react['"]|from\s+['"]next\/|\buse(?:state|effect|memo|callback)\b)/i.test(sample) && /<\w[\s\S]*>/.test(sample)) {
    if (/: \s*(React\.)?[A-Z]\w+|interface\s+\w+Props|type\s+\w+\s*=/.test(sample)) {
      return 'tsx';
    }
    return 'jsx';
  }

  if (/<template\b[\s\S]*<\/template>/i.test(sample) || /<script\s+setup\b/i.test(sample)) {
    return 'vue';
  }

  if (/\b(terraform|required_providers|provider|resource|module|variable|output|locals)\b[\s\S]*?=/i.test(sample) || /\bresource\s+"[^"]+"\s+"[^"]+"/i.test(sample)) {
    return 'terraform';
  }

  if ((sample.startsWith('{') || sample.startsWith('[')) && looksLikeJson(sample)) {
    return 'json';
  }

  const normalizedLines = sample
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (normalizedLines.length > 0) {
    const posixPathLines = normalizedLines.filter((line) => (
      /^(?:\.{1,2}\/|~\/|\/)[^\s]+$/.test(line)
      || /^(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+$/.test(line)
    ));
    const windowsPathLines = normalizedLines.filter((line) => (
      /^[A-Za-z]:\\[^\s]+$/.test(line) || /^\\\\[^\s]+\\[^\s]+/.test(line)
    ));

    if (windowsPathLines.length > 0 && windowsPathLines.length === normalizedLines.length) {
      return 'powershell';
    }

    if (posixPathLines.length > 0 && posixPathLines.length === normalizedLines.length) {
      return 'shellscript';
    }
  }

  if (/^<!doctype html\b/i.test(sample) || /<\/?(html|head|body|div|span|section|article|script|style|main|header|footer)\b/i.test(sample)) {
    return 'html';
  }

  if (/^<\?xml\b/i.test(sample) || /<\/?[a-z_][\w:.-]*\b[^>]*>/i.test(sample)) {
    return 'xml';
  }

  if (/^\[[^\]\n]+\]\s*$/m.test(sample) && /^\s*[\w.-]+\s*=\s*.+$/m.test(sample)) {
    return 'toml';
  }

  if (/^\[[^\]\n]+\]\s*$/m.test(sample) && /^\s*[\w.-]+\s*[:=]\s*.+$/m.test(sample)) {
    return 'ini';
  }

  if ((/^[\w.-]+\s*:\s*.+$/m.test(sample) || /^-\s+\w[^:]*:\s*.+$/m.test(sample)) && !/[{};]/.test(sample)) {
    return 'yaml';
  }

  if (/\b(select|insert|update|delete|create|alter|drop|with)\b[\s\S]*\b(from|into|table)\b/i.test(sample)) {
    return 'sql';
  }

  if (/^#!.*\b(bash|sh|zsh)\b/m.test(sample) || /(^|\n)\s*(export|echo|npm|pnpm|yarn|curl|grep|awk|sed|chmod|mkdir|ls)\b/m.test(sample) || /(^|\n)\s*\$\s+\S+/m.test(sample)) {
    return 'shellscript';
  }

  if (/\b(get-[a-z]+|set-[a-z]+|write-host|write-output|foreach-object|where-object)\b/i.test(sample) || /\$env:[a-z_][\w-]*/i.test(sample) || /\bparam\s*\(/i.test(sample)) {
    return 'powershell';
  }

  if (/\bpackage\s+main\b/.test(lower) || /\bfunc\s+\w+\s*\(/.test(lower) || /\bfmt\.\w+\(/.test(lower)) {
    return 'go';
  }

  if (/\busing\s+system\b/.test(lower) || /\bconsole\.writeline\s*\(/.test(lower) || /\bnamespace\s+[A-Z][\w.]*/.test(sample)) {
    return 'csharp';
  }

  if (/\bpublic\s+(class|interface|enum)\b/.test(lower) || /\bpublic\s+static\s+void\s+main\b/.test(lower) || /\b(system\.out|import\s+java\.)/.test(lower)) {
    return 'java';
  }

  if (/\bfun\s+main\s*\(/.test(lower) || /\bdata\s+class\b/.test(lower) || /\bval\s+\w+\s*[:=]/.test(lower) && /\bprintln\s*\(/.test(lower)) {
    return 'kotlin';
  }

  if (/\bimport\s+(swiftui|foundation)\b/.test(lower) || /\bstruct\s+\w+\s*:\s*view\b/.test(lower)) {
    return 'swift';
  }

  if (/\bdef\s+\w+\s*\(/.test(lower) || /\bfrom\s+\w+(?:\.\w+)*\s+import\b/.test(lower) || /\bif\s+__name__\s*==\s*['"]__main__['"]/.test(lower) || /\bprint\s*\(/.test(lower)) {
    return 'python';
  }

  if (
    (/\bclass\s+\w+\b/.test(sample) && /\bdef\s+\w+[!?=]?\b/.test(sample) && /\bend\b/.test(lower))
    || /\bputs\s+['"]/.test(sample)
    || /\brequire\s+['"][^'"]+['"]/.test(sample)
  ) {
    return 'ruby';
  }

  if (/\bfn\s+\w+\s*\(/.test(lower) || /\blet\s+mut\b/.test(lower) || /\bprintln!\s*\(/.test(lower)) {
    return 'rust';
  }

  if (/^\s*#include\s+<[^>]+>/m.test(sample)) {
    if (/\bstd::|cout\s*<</.test(sample) || /<iostream>/.test(sample)) {
      return 'cpp';
    }
    return 'c';
  }

  if (/[.#]?[a-z-][\w-]*\s*\{[\s\S]*:[^;]+;/.test(sample)) {
    return 'css';
  }

  if (/\binterface\s+\w+\b/.test(lower) || /\btype\s+\w+\s*=/.test(lower) || /\bimport\s+type\b/.test(lower) || /:\s*(string|number|boolean|unknown|never|void|any)(\[\])?[\s,)=;]/.test(lower)) {
    return 'typescript';
  }

  if (/\b(const|let|var)\b/.test(lower) || /\bfunction\s+\w+\s*\(/.test(lower) || /=>/.test(sample) || /\bconsole\.\w+\(/.test(lower)) {
    return 'javascript';
  }

  return null;
}

function looksLikeJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
