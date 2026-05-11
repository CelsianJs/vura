//! AST-based route and page scanner.
//!
//! Parses TypeScript/JSX files with swc_ecma_parser and walks the AST to extract:
//! - Exported HTTP method functions (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS)
//! - Route config: `export const route = { kind: 'serverless', ... }`
//! - Page config: `export const page = { mode: 'static', ... }`
//! - Default exports and getServerData exports

use crate::ScanResult;
use swc_common::{
    input::StringInput,
    sync::Lrc,
    SourceMap,
};
use swc_ecma_ast::*;
use swc_ecma_parser::{lexer::Lexer, Parser, Syntax, TsSyntax, EsSyntax};

const HTTP_METHODS: &[&str] = &["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

pub fn scan(source: &str, file_type: &str) -> anyhow::Result<ScanResult> {
    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(
        Lrc::new(swc_common::FileName::Anon),
        source.to_string(),
    );

    let syntax = match file_type {
        "ts" => Syntax::Typescript(TsSyntax {
            tsx: false,
            decorators: true,
            ..Default::default()
        }),
        "tsx" => Syntax::Typescript(TsSyntax {
            tsx: true,
            decorators: true,
            ..Default::default()
        }),
        "jsx" => Syntax::Es(EsSyntax {
            jsx: true,
            ..Default::default()
        }),
        _ => Syntax::Es(EsSyntax::default()),
    };

    let lexer = Lexer::new(
        syntax,
        EsVersion::Es2022,
        StringInput::from(&*fm),
        None,
    );

    let mut parser = Parser::new_from(lexer);
    let module = parser
        .parse_module()
        .map_err(|e| anyhow::anyhow!("Parse error: {:?}", e))?;

    let mut methods: Vec<String> = Vec::new();
    let mut kind = String::from("serverless");
    let mut has_default_export = false;
    let mut has_get_server_data = false;
    let mut page_mode: Option<String> = None;
    let mut config = serde_json::Map::new();

    for item in &module.body {
        match item {
            ModuleItem::ModuleDecl(decl) => {
                match decl {
                    // export function GET(...) / export async function GET(...)
                    ModuleDecl::ExportDecl(export_decl) => {
                        match &export_decl.decl {
                            Decl::Fn(fn_decl) => {
                                let name = fn_decl.ident.sym.as_ref();
                                if HTTP_METHODS.contains(&name) {
                                    methods.push(name.to_string());
                                }
                                if name == "getServerData" {
                                    has_get_server_data = true;
                                }
                            }
                            // export const GET = ... / export const route = { ... }
                            Decl::Var(var_decl) => {
                                for decl in &var_decl.decls {
                                    if let Pat::Ident(ident) = &decl.name {
                                        let name = ident.id.sym.as_ref();

                                        // Check for HTTP method exports
                                        if HTTP_METHODS.contains(&name) {
                                            methods.push(name.to_string());
                                        }

                                        if name == "getServerData" {
                                            has_get_server_data = true;
                                        }

                                        // Extract route config
                                        if name == "route" {
                                            if let Some(init) = &decl.init {
                                                extract_object_config(init, &mut kind, &mut config, "route");
                                            }
                                        }

                                        // Extract page config
                                        if name == "page" {
                                            if let Some(init) = &decl.init {
                                                let mut page_kind = String::new();
                                                extract_object_config(init, &mut page_kind, &mut config, "page");
                                                if let Some(mode) = config.get("mode") {
                                                    if let Some(mode_str) = mode.as_str() {
                                                        page_mode = Some(mode_str.to_string());
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }

                    // export default function ...
                    ModuleDecl::ExportDefaultDecl(_) => {
                        has_default_export = true;
                    }

                    // export default expr
                    ModuleDecl::ExportDefaultExpr(_) => {
                        has_default_export = true;
                    }

                    _ => {}
                }
            }
            _ => {}
        }
    }

    // Extract kind from config if present
    if let Some(kind_val) = config.get("kind") {
        if let Some(k) = kind_val.as_str() {
            kind = k.to_string();
        }
    }

    Ok(ScanResult {
        methods,
        kind,
        has_default_export,
        has_get_server_data,
        page_mode,
        config: serde_json::Value::Object(config),
    })
}

/// Extract key-value pairs from an object literal expression.
fn extract_object_config(
    expr: &Expr,
    kind: &mut String,
    config: &mut serde_json::Map<String, serde_json::Value>,
    _context: &str,
) {
    if let Expr::Object(obj) = unbox_expr(expr) {
        for prop in &obj.props {
            if let PropOrSpread::Prop(prop) = prop {
                if let Prop::KeyValue(kv) = prop.as_ref() {
                    let key = match &kv.key {
                        PropName::Ident(ident) => Some(ident.sym.to_string()),
                        PropName::Str(s) => Some(s.value.to_string()),
                        _ => None,
                    };

                    if let Some(key) = key {
                        match unbox_expr(&kv.value) {
                            Expr::Lit(Lit::Str(s)) => {
                                let val = s.value.to_string();
                                if key == "kind" {
                                    *kind = val.clone();
                                }
                                config.insert(key, serde_json::Value::String(val));
                            }
                            Expr::Lit(Lit::Num(n)) => {
                                config.insert(
                                    key,
                                    serde_json::Value::Number(
                                        serde_json::Number::from_f64(n.value)
                                            .unwrap_or(serde_json::Number::from(0)),
                                    ),
                                );
                            }
                            Expr::Lit(Lit::Bool(b)) => {
                                config.insert(key, serde_json::Value::Bool(b.value));
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }

    // Handle `as const` expressions
    if let Expr::TsAs(ts_as) = expr {
        extract_object_config(&ts_as.expr, kind, config, _context);
    }
}

/// Unwrap parenthesized and type assertion expressions.
fn unbox_expr(expr: &Expr) -> &Expr {
    match expr {
        Expr::Paren(p) => unbox_expr(&p.expr),
        Expr::TsAs(ts) => unbox_expr(&ts.expr),
        Expr::TsSatisfies(ts) => unbox_expr(&ts.expr),
        Expr::TsTypeAssertion(ts) => unbox_expr(&ts.expr),
        _ => expr,
    }
}
