//! JSX Transformer
//!
//! Transforms JSX elements into What Framework function calls:
//! - Development: `h(tag, props, ...children)`
//! - Production: `template()`/`insert()` calls matching compiled output
//!
//! This is a placeholder implementation that currently transforms to h() calls.
//! Full template/insert transform will match what-fw/packages/compiler/src/babel-plugin.js.

use crate::TransformResult;

/// Transform JSX source to What Framework h() calls.
///
/// Currently returns the source unchanged with an auto-import prepended,
/// since the actual JSX transform requires a full AST rewrite pass.
/// The napi-rs build will use swc's built-in JSX transform with the
/// configured jsxImportSource.
pub fn transform(
    source: &str,
    jsx_import_source: &str,
    production: bool,
) -> anyhow::Result<TransformResult> {
    // For now, delegate to swc's built-in JSX transform by prepending the pragma.
    // A full custom transform (template/insert) will be implemented in a follow-up.
    //
    // The actual transform happens via:
    // 1. swc_ecma_parser (parse JSX)
    // 2. swc_ecma_transforms_react (JSX → h() calls)
    // 3. swc_ecma_codegen (emit JS)
    //
    // This placeholder just adds the import and returns the source,
    // suitable for being piped through esbuild's JSX transform.

    let import_line = if production {
        format!(
            "import {{ template, insert, createComponent }} from '{}/server';\n",
            jsx_import_source
        )
    } else {
        format!(
            "import {{ jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment }} from '{}/jsx-runtime';\n",
            jsx_import_source
        )
    };

    Ok(TransformResult {
        code: format!("{}{}", import_line, source),
        map: None,
    })
}
