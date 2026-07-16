//! AST-based route and page scanner.
//!
//! Route metadata is accepted only as a restricted static literal. The native
//! scanner deliberately mirrors the JavaScript fallback: it never evaluates a
//! module, rejects dynamic route config, preserves nested literals, normalizes
//! compute placement, and exposes only Function or Dedicated compute.

use crate::ScanResult;
use napi::bindgen_prelude::{Either, Null};
use serde_json::{Map, Number, Value};
use swc_common::{input::StringInput, sync::Lrc, SourceMap, Span, Spanned};
use swc_ecma_ast::*;
use swc_ecma_parser::{lexer::Lexer, EsSyntax, Parser, Syntax, TsSyntax};

const HTTP_METHODS: &[&str] = &["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
const FUNCTION_MEMORY: &[&str] = &["1gb", "4gb", "6gb", "8gb", "12gb"];

enum ParsedValue {
    Value(Value),
    /// Page presentation metadata may refer to values evaluated by the page
    /// renderer. Omit those references from the build manifest.
    Omit,
}

struct StaticConfigScanner<'a> {
    cm: &'a Lrc<SourceMap>,
}

impl StaticConfigScanner<'_> {
    fn error(&self, span: Span, context: &str, message: &str) -> anyhow::Error {
        let loc = self.cm.lookup_char_pos(span.lo());
        anyhow::anyhow!(
            "[VURA_CONFIG] {} config at {}:{}: {}",
            context,
            loc.line,
            loc.col_display + 1,
            message,
        )
    }

    fn object(
        &self,
        expr: &Expr,
        context: &str,
        omit_identifier_references: bool,
    ) -> anyhow::Result<Map<String, Value>> {
        match self.value(expr, context, omit_identifier_references)? {
            ParsedValue::Value(Value::Object(value)) => Ok(value),
            _ => Err(self.error(expr.span(), context, "expected a plain object literal")),
        }
    }

    fn value(
        &self,
        expr: &Expr,
        context: &str,
        omit_identifier_references: bool,
    ) -> anyhow::Result<ParsedValue> {
        match expr {
            Expr::Paren(value) => self.value(&value.expr, context, omit_identifier_references),
            Expr::TsAs(value) => self.value(&value.expr, context, omit_identifier_references),
            Expr::TsConstAssertion(value) => {
                self.value(&value.expr, context, omit_identifier_references)
            }
            Expr::TsSatisfies(value) => {
                self.value(&value.expr, context, omit_identifier_references)
            }
            Expr::TsTypeAssertion(value) => {
                self.value(&value.expr, context, omit_identifier_references)
            }
            Expr::Object(object) => {
                let mut result = Map::new();
                for property in &object.props {
                    let property = match property {
                        PropOrSpread::Spread(spread) => {
                            return Err(self.error(
                                spread.dot3_token,
                                context,
                                "spread properties are not allowed",
                            ));
                        }
                        PropOrSpread::Prop(property) => property,
                    };

                    let key_value = match property.as_ref() {
                        Prop::KeyValue(value) => value,
                        Prop::Shorthand(value) => {
                            return Err(self.error(
                                value.span,
                                context,
                                "object properties must use key: literal syntax",
                            ));
                        }
                        other => {
                            return Err(self.error(
                                other.span(),
                                context,
                                "object properties must use key: literal syntax",
                            ));
                        }
                    };

                    let key = match &key_value.key {
                        PropName::Ident(value) => value.sym.to_string(),
                        PropName::Str(value) => value.value.to_string(),
                        PropName::Computed(value) => {
                            return Err(self.error(
                                value.span,
                                context,
                                "computed properties are not allowed",
                            ));
                        }
                        other => {
                            return Err(self.error(
                                other.span(),
                                context,
                                "object keys must be identifiers or string literals",
                            ));
                        }
                    };

                    let omit_property_reference =
                        omit_identifier_references || (context == "page" && key == "styles");
                    let parsed = self.value(&key_value.value, context, omit_property_reference)?;
                    if let ParsedValue::Value(value) = parsed {
                        result.insert(key, value);
                    }
                }
                Ok(ParsedValue::Value(Value::Object(result)))
            }
            Expr::Array(array) => {
                let mut result = Vec::new();
                let mut has_dynamic_value = false;
                for element in &array.elems {
                    let element = element.as_ref().ok_or_else(|| {
                        self.error(array.span, context, "array holes are not allowed")
                    })?;
                    if let Some(spread) = element.spread {
                        return Err(self.error(spread, context, "array spreads are not allowed"));
                    }
                    match self.value(&element.expr, context, omit_identifier_references)? {
                        ParsedValue::Value(value) => result.push(value),
                        ParsedValue::Omit => has_dynamic_value = true,
                    }
                }
                if has_dynamic_value {
                    Ok(ParsedValue::Omit)
                } else {
                    Ok(ParsedValue::Value(Value::Array(result)))
                }
            }
            Expr::Lit(Lit::Str(value)) => {
                Ok(ParsedValue::Value(Value::String(value.value.to_string())))
            }
            Expr::Lit(Lit::Bool(value)) => Ok(ParsedValue::Value(Value::Bool(value.value))),
            Expr::Lit(Lit::Null(_)) => Ok(ParsedValue::Value(Value::Null)),
            Expr::Lit(Lit::Num(value)) => self.number(
                value.value,
                value.raw.as_ref().map(|raw| raw.as_ref()),
                value.span,
                context,
            ),
            Expr::Unary(value) if value.op == UnaryOp::Minus => {
                if let Expr::Lit(Lit::Num(number)) = value.arg.as_ref() {
                    self.number(
                        -number.value,
                        number.raw.as_ref().map(|raw| raw.as_ref()),
                        value.span,
                        context,
                    )
                } else {
                    Err(self.error(value.span, context, "invalid numeric literal"))
                }
            }
            Expr::Ident(value) if omit_identifier_references => {
                let _ = value;
                Ok(ParsedValue::Omit)
            }
            Expr::Ident(value) => {
                Err(self.error(value.span, context, "identifiers are not allowed as values"))
            }
            Expr::Call(value) => {
                Err(self.error(value.span, context, "identifiers are not allowed as values"))
            }
            Expr::Tpl(value) => {
                Err(self.error(value.span, context, "template literals are not allowed"))
            }
            other => Err(self.error(other.span(), context, "expected a static literal")),
        }
    }

    fn number(
        &self,
        value: f64,
        raw: Option<&str>,
        span: Span,
        context: &str,
    ) -> anyhow::Result<ParsedValue> {
        if raw.is_some_and(|raw| !is_decimal_literal(raw)) {
            return Err(self.error(span, context, "invalid numeric literal"));
        }
        if !value.is_finite() {
            return Err(self.error(span, context, "numeric literal must be finite"));
        }
        let value = Number::from_f64(value)
            .ok_or_else(|| self.error(span, context, "invalid numeric literal"))?;
        Ok(ParsedValue::Value(Value::Number(value)))
    }
}

/// Match the JavaScript fallback's intentionally narrow decimal grammar.
/// Hex, octal, binary, bigint, and malformed separator forms are not config
/// literals even though the TypeScript parser can represent some of them.
fn is_decimal_literal(raw: &str) -> bool {
    fn digits(bytes: &[u8], index: &mut usize) -> bool {
        if !bytes.get(*index).is_some_and(u8::is_ascii_digit) {
            return false;
        }
        *index += 1;
        while *index < bytes.len() {
            if bytes[*index].is_ascii_digit() {
                *index += 1;
            } else if bytes[*index] == b'_' && bytes.get(*index + 1).is_some_and(u8::is_ascii_digit)
            {
                *index += 2;
            } else {
                break;
            }
        }
        true
    }

    let bytes = raw.as_bytes();
    let mut index = 0;
    if bytes.first() == Some(&b'.') {
        index += 1;
        if !digits(bytes, &mut index) {
            return false;
        }
    } else {
        if !digits(bytes, &mut index) {
            return false;
        }
        if bytes.get(index) == Some(&b'.') {
            index += 1;
            if bytes.get(index).is_some_and(u8::is_ascii_digit) && !digits(bytes, &mut index) {
                return false;
            }
        }
    }

    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+' | b'-')) {
            index += 1;
        }
        if !digits(bytes, &mut index) {
            return false;
        }
    }
    index == bytes.len()
}

pub fn scan(source: &str, file_type: &str) -> anyhow::Result<ScanResult> {
    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(Lrc::new(swc_common::FileName::Anon), source.to_string());

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

    let lexer = Lexer::new(syntax, EsVersion::Es2022, StringInput::from(&*fm), None);
    let mut parser = Parser::new_from(lexer);
    let module = parser.parse_module().map_err(|error| {
        let loc = cm.lookup_char_pos(error.span().lo());
        anyhow::anyhow!(
            "Parse error at {}:{}: {:?}",
            loc.line,
            loc.col_display + 1,
            error,
        )
    })?;

    let mut method_exports = Vec::new();
    let mut has_default_export = false;
    let mut has_get_server_data = false;
    let mut has_websocket = false;
    let mut route_expr: Option<&Expr> = None;
    let mut page_expr: Option<&Expr> = None;
    let mut kind_expr: Option<&Expr> = None;
    let mut schedule_expr: Option<&Expr> = None;

    for item in &module.body {
        let ModuleItem::ModuleDecl(declaration) = item else {
            continue;
        };
        match declaration {
            ModuleDecl::ExportDecl(export) => match &export.decl {
                Decl::Fn(function) => {
                    let name = function.ident.sym.as_ref();
                    if HTTP_METHODS.contains(&name) {
                        method_exports.push(name.to_string());
                    }
                    if name == "getServerData" {
                        has_get_server_data = true;
                    }
                    if name == "websocket" {
                        has_websocket = true;
                    }
                }
                Decl::Var(variable) => {
                    for declarator in &variable.decls {
                        let Pat::Ident(identifier) = &declarator.name else {
                            continue;
                        };
                        let name = identifier.id.sym.as_ref();

                        if variable.kind == VarDeclKind::Const && HTTP_METHODS.contains(&name) {
                            method_exports.push(name.to_string());
                        }
                        if matches!(variable.kind, VarDeclKind::Const | VarDeclKind::Let)
                            && name == "getServerData"
                        {
                            has_get_server_data = true;
                        }
                        if variable.kind == VarDeclKind::Const && name == "websocket" {
                            has_websocket = true;
                        }
                        if variable.kind != VarDeclKind::Const {
                            continue;
                        }
                        let Some(initializer) = declarator.init.as_deref() else {
                            continue;
                        };
                        match name {
                            "route" => route_expr = Some(initializer),
                            "page" => page_expr = Some(initializer),
                            "kind" => kind_expr = Some(initializer),
                            "schedule" => schedule_expr = Some(initializer),
                            _ => {}
                        }
                    }
                }
                _ => {}
            },
            ModuleDecl::ExportDefaultDecl(_) | ModuleDecl::ExportDefaultExpr(_) => {
                has_default_export = true;
            }
            _ => {}
        }
    }

    method_exports.sort_by_key(|method| {
        HTTP_METHODS
            .iter()
            .position(|candidate| candidate == method)
            .unwrap_or(HTTP_METHODS.len())
    });
    method_exports.dedup();

    let scanner = StaticConfigScanner { cm: &cm };
    let has_route_config = route_expr.is_some() || kind_expr.is_some();
    let (kind, mut config) = if !method_exports.is_empty() || has_websocket || has_route_config {
        read_route_config(&scanner, route_expr, kind_expr, schedule_expr)?
    } else {
        (String::from("serverless"), Map::new())
    };

    let page_config = if let Some(page) = page_expr {
        scanner.object(page, "page", false)?
    } else {
        Map::new()
    };
    let mut page_mode = page_config
        .get("mode")
        .and_then(Value::as_str)
        .map(str::to_string);
    config.extend(page_config);

    if page_mode.is_none() && has_get_server_data {
        page_mode = Some(String::from("server"));
    }

    Ok(ScanResult {
        methods: method_exports,
        kind,
        has_default_export,
        has_get_server_data,
        page_mode: page_mode.map(Either::A).unwrap_or_else(|| Either::B(Null)),
        config: Value::Object(config),
    })
}

fn read_route_config(
    scanner: &StaticConfigScanner<'_>,
    route_expr: Option<&Expr>,
    kind_expr: Option<&Expr>,
    schedule_expr: Option<&Expr>,
) -> anyhow::Result<(String, Map<String, Value>)> {
    let mut config = if let Some(route) = route_expr {
        scanner.object(route, "route", false)?
    } else {
        Map::new()
    };

    if route_expr.is_none() {
        if let Some(kind) = kind_expr {
            match scanner.value(kind, "route kind", false)? {
                ParsedValue::Value(Value::String(value)) => {
                    config.insert(String::from("kind"), Value::String(value));
                }
                _ => {
                    return Err(scanner.error(
                        kind.span(),
                        "route",
                        "exported route kind must be a string literal",
                    ));
                }
            }
        }
    }

    if !config.contains_key("schedule") {
        if let Some(schedule) = schedule_expr {
            match scanner.value(schedule, "route schedule", false)? {
                ParsedValue::Value(Value::String(value)) => {
                    config.insert(String::from("schedule"), Value::String(value));
                }
                _ => {
                    return Err(scanner.error(
                        schedule.span(),
                        "route",
                        "exported task schedule must be a string literal",
                    ));
                }
            }
        }
    }

    let span = route_expr
        .map(Spanned::span)
        .or_else(|| kind_expr.map(Spanned::span))
        .or_else(|| schedule_expr.map(Spanned::span))
        .unwrap_or_default();
    normalize_route_config(scanner, config, span)
}

fn normalize_route_config(
    scanner: &StaticConfigScanner<'_>,
    mut config: Map<String, Value>,
    span: Span,
) -> anyhow::Result<(String, Map<String, Value>)> {
    let kind = match config.get("kind") {
        None => String::from("serverless"),
        Some(Value::String(value)) if matches!(value.as_str(), "serverless" | "hot" | "task") => {
            value.clone()
        }
        Some(_) => {
            return Err(scanner.error(
                span,
                "route",
                "route.kind must be 'serverless', 'hot', or 'task'",
            ));
        }
    };

    if config
        .get("compute")
        .is_some_and(|value| !value.is_object())
    {
        return Err(scanner.error(
            span,
            "route",
            "route.compute must be a plain object literal",
        ));
    }
    if config
        .get("machine")
        .is_some_and(|value| !value.is_object())
    {
        return Err(scanner.error(
            span,
            "route",
            "legacy route.machine must be a plain object literal",
        ));
    }

    let raw_compute = config
        .get("compute")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let machine = config
        .get("machine")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let explicit_class = match raw_compute.get("class") {
        None => None,
        Some(Value::String(value))
            if matches!(value.as_str(), "function" | "dedicated") =>
        {
            Some(value.clone())
        }
        Some(_) => {
            return Err(scanner.error(
                span,
                "route",
                "route.compute.class must be 'function' or 'dedicated'",
            ));
        }
    };

    let has_legacy_hot_marker = config.get("hot") == Some(&Value::Bool(true))
        || ["runtime", "placement", "target"]
            .iter()
            .any(|key| config.get(*key).and_then(Value::as_str) == Some("hot"));
    let legacy_dedicated = kind == "hot" || has_legacy_hot_marker || !machine.is_empty();
    let requested_class = explicit_class.clone().unwrap_or_else(|| {
        if legacy_dedicated {
            String::from("dedicated")
        } else {
            String::from("function")
        }
    });

    if kind == "hot"
        && explicit_class
            .as_deref()
            .is_some_and(|value| value != "dedicated")
    {
        return Err(scanner.error(
            span,
            "route",
            "kind: 'hot' conflicts with a non-dedicated compute.class",
        ));
    }

    let compute = match requested_class.as_str() {
        "function" => normalize_function(scanner, raw_compute, span)?,
        "dedicated" => normalize_dedicated(scanner, machine.clone(), raw_compute, span)?,
        _ => unreachable!("compute class was validated above"),
    };
    if requested_class == "dedicated" {
        let compatible_machine = dedicated_machine_compatibility(machine, &compute);
        if !compatible_machine.is_empty() {
            config.insert(String::from("machine"), Value::Object(compatible_machine));
        }
        if kind == "task" && !has_legacy_hot_marker {
            config.insert(String::from("hot"), Value::Bool(true));
        }
    }
    config.insert(String::from("compute"), Value::Object(compute));

    let effective_kind = if kind == "task" {
        "task"
    } else if requested_class == "dedicated" {
        "hot"
    } else {
        "serverless"
    };
    Ok((effective_kind.to_string(), config))
}

fn normalize_function(
    scanner: &StaticConfigScanner<'_>,
    mut compute: Map<String, Value>,
    span: Span,
) -> anyhow::Result<Map<String, Value>> {
    let memory = compute
        .get("memory")
        .and_then(Value::as_str)
        .unwrap_or("1gb")
        .to_owned();
    if !FUNCTION_MEMORY.contains(&memory.as_str())
        || compute
            .get("memory")
            .is_some_and(|value| !value.is_string())
    {
        return Err(scanner.error(
            span,
            "route",
            "Function memory must be one of '1gb', '4gb', '6gb', '8gb', or '12gb'",
        ));
    }
    assert_cpu(scanner, compute.get("cpu"), span)?;
    compute.insert(
        String::from("class"),
        Value::String(String::from("function")),
    );
    compute.insert(String::from("memory"), Value::String(memory));
    Ok(compute)
}

fn normalize_dedicated(
    scanner: &StaticConfigScanner<'_>,
    mut machine: Map<String, Value>,
    mut compute: Map<String, Value>,
    span: Span,
) -> anyhow::Result<Map<String, Value>> {
    let size = match compute.get("size") {
        None => None,
        Some(Value::String(value)) => Some(value.clone()),
        Some(_) => {
            return Err(scanner.error(
                span,
                "route",
                "Dedicated size must be one of 'nano', 'small', 'medium', 'large', 'xlarge', '2xlarge', or '4xlarge'",
            ));
        }
    };
    let profile = match size.as_deref() {
        None => None,
        Some("nano") => Some(("256mb", 1)),
        Some("small") => Some(("512mb", 1)),
        Some("medium") => Some(("1gb", 1)),
        Some("large") => Some(("2gb", 2)),
        Some("xlarge") => Some(("4gb", 2)),
        Some("2xlarge") => Some(("8gb", 4)),
        Some("4xlarge") => Some(("16gb", 8)),
        Some(_) => {
            return Err(scanner.error(
                span,
                "route",
                "Dedicated size must be one of 'nano', 'small', 'medium', 'large', 'xlarge', '2xlarge', or '4xlarge'",
            ));
        }
    };
    if profile.is_some()
        && ["memory", "memoryMb", "cpu", "cpus"]
            .iter()
            .any(|key| compute.contains_key(*key) || machine.contains_key(*key))
    {
        return Err(scanner.error(
            span,
            "route",
            "Dedicated size cannot be combined with custom memory or CPU",
        ));
    }
    if let Some((memory, cpus)) = profile {
        compute.insert(String::from("memory"), Value::String(String::from(memory)));
        compute.insert(String::from("cpu"), Value::Number(Number::from(cpus)));
    }
    let cpu = [
        compute.get("cpu"),
        compute.get("cpus"),
        machine.get("cpu"),
        machine.get("cpus"),
    ]
    .into_iter()
    .flatten()
    .find(|value| !value.is_null());
    assert_cpu(scanner, cpu, span)?;
    machine.extend(compute);
    machine.insert(
        String::from("class"),
        Value::String(String::from("dedicated")),
    );
    Ok(machine)
}

fn dedicated_machine_compatibility(
    mut machine: Map<String, Value>,
    compute: &Map<String, Value>,
) -> Map<String, Value> {
    if let Some(memory_mb) = compute
        .get("memory")
        .or_else(|| compute.get("memoryMb"))
        .and_then(memory_to_mb)
        .and_then(Number::from_f64)
    {
        machine.insert(String::from("memoryMb"), Value::Number(memory_mb));
    }
    if let Some(cpu) = compute
        .get("cpu")
        .or_else(|| compute.get("cpus"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .and_then(Number::from_f64)
    {
        machine.insert(String::from("cpus"), Value::Number(cpu));
    }
    machine
}

fn memory_to_mb(value: &Value) -> Option<f64> {
    if let Some(value) = value.as_f64() {
        return (value.is_finite() && value > 0.0).then(|| value.floor());
    }
    let raw = value.as_str()?.trim().to_ascii_lowercase();
    let (amount, multiplier) = if let Some(amount) = raw.strip_suffix("gib") {
        (amount, 1024.0)
    } else if let Some(amount) = raw.strip_suffix("gb") {
        (amount, 1024.0)
    } else if let Some(amount) = raw.strip_suffix("mib") {
        (amount, 1.0)
    } else {
        (raw.strip_suffix("mb")?, 1.0)
    };
    let amount = amount.trim().parse::<f64>().ok()?;
    (amount.is_finite() && amount > 0.0).then(|| (amount * multiplier).floor())
}

fn assert_cpu(
    scanner: &StaticConfigScanner<'_>,
    cpu: Option<&Value>,
    span: Span,
) -> anyhow::Result<()> {
    if let Some(cpu) = cpu {
        let valid = cpu
            .as_f64()
            .is_some_and(|value| value.is_finite() && value > 0.0 && value.fract() == 0.0);
        if !valid {
            return Err(scanner.error(
                span,
                "route",
                "route.compute.cpu must be a positive integer",
            ));
        }
    }
    Ok(())
}
