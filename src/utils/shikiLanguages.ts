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
