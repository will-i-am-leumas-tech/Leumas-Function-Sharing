import ast
import json
import sys


TYPE_MAP = {
    "str": "string",
    "int": "number",
    "float": "number",
    "complex": "number",
    "bool": "boolean",
    "dict": "object",
    "Dict": "object",
    "Mapping": "object",
    "MutableMapping": "object",
    "list": "array",
    "List": "array",
    "tuple": "array",
    "Tuple": "array",
    "set": "array",
    "Set": "array",
    "Sequence": "array",
    "Iterable": "array",
    "None": "null",
    "NoneType": "null",
    "Any": "unknown",
    "Callable": "function",
}


def node_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = node_name(node.value)
        return f"{base}.{node.attr}" if base else node.attr
    if isinstance(node, ast.Constant) and node.value is None:
        return "None"
    try:
        return ast.unparse(node)
    except Exception:
        return "unknown"


def normalize_type_name(raw):
    if not raw:
        return "unknown"
    leaf = raw.split(".")[-1]
    return TYPE_MAP.get(leaf, TYPE_MAP.get(raw, raw))


def merge_union(contracts):
    types = []
    for contract in contracts:
        raw_type = contract.get("type") or "unknown"
        for part in [item.strip() for item in raw_type.split("|")]:
            if part and part not in types:
                types.append(part)
    return {"type": " | ".join(types) if types else "unknown"}


def get_slice_parts(node):
    if isinstance(node, ast.Tuple):
        return list(node.elts)
    return [node]


def contract_from_annotation(node):
    if node is None:
        return {"type": "unknown"}

    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return merge_union([
            contract_from_annotation(node.left),
            contract_from_annotation(node.right),
        ])

    if isinstance(node, ast.Constant):
        if node.value is None:
            return {"type": "null"}
        return {"type": normalize_type_name(type(node.value).__name__)}

    if isinstance(node, (ast.Name, ast.Attribute)):
        return {"type": normalize_type_name(node_name(node))}

    if isinstance(node, ast.Subscript):
        outer = normalize_type_name(node_name(node.value))
        parts = get_slice_parts(node.slice)

        if outer in ("array", "tuple", "set"):
            contract = {"type": "array"}
            if parts:
                contract["items"] = contract_from_annotation(parts[0])
            return contract

        if outer == "object":
            return {"type": "object"}

        if outer in ("Optional", "typing.Optional") and parts:
            return merge_union([contract_from_annotation(parts[0]), {"type": "null"}])

        if outer in ("Union", "typing.Union"):
            return merge_union([contract_from_annotation(part) for part in parts])

        if outer in ("function", "typing.Callable"):
            return {"type": "function"}

        if outer in ("Literal", "typing.Literal"):
            literal_contracts = []
            for part in parts:
                if isinstance(part, ast.Constant):
                    literal_contracts.append({"type": normalize_type_name(type(part.value).__name__)})
            return merge_union(literal_contracts) if literal_contracts else {"type": "unknown"}

        try:
            return {"type": ast.unparse(node)}
        except Exception:
            return {"type": "unknown"}

    try:
        return {"type": normalize_type_name(ast.unparse(node))}
    except Exception:
        return {"type": "unknown"}


def contract_from_default(node):
    if node is None:
        return {"type": "unknown"}
    if isinstance(node, ast.Constant):
        if node.value is None:
            return {"type": "null"}
        if isinstance(node.value, bool):
            return {"type": "boolean"}
        if isinstance(node.value, (int, float, complex)):
            return {"type": "number"}
        if isinstance(node.value, str):
            return {"type": "string"}
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return {"type": "array"}
    if isinstance(node, ast.Dict):
        return {"type": "object"}
    if isinstance(node, ast.Lambda):
        return {"type": "function"}
    return {"type": "unknown"}


def apply_default_type(annotation_contract, default_node):
    contract = dict(annotation_contract or {"type": "unknown"})
    default_contract = contract_from_default(default_node)
    if contract.get("type") == "unknown" and default_contract.get("type") != "unknown":
        contract.update(default_contract)
    return contract


def parse_doc_contracts(docstring):
    if not docstring:
        return {}, None

    param_docs = {}
    return_doc = None
    lines = docstring.splitlines()
    block = None

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue

        if line.lower() in ("args:", "arguments:", "parameters:"):
            block = "params"
            continue
        if line.lower() in ("returns:", "return:"):
            block = "returns"
            continue
        if line.startswith(":param "):
            rest = line[len(":param "):]
            name, _, desc = rest.partition(":")
            if name.strip():
                param_docs.setdefault(name.strip(), {})["description"] = desc.strip()
            continue
        if line.startswith(":type "):
            rest = line[len(":type "):]
            name, _, typ = rest.partition(":")
            if name.strip() and typ.strip():
                param_docs.setdefault(name.strip(), {})["type"] = normalize_type_name(typ.strip())
            continue
        if line.startswith(":return") or line.startswith(":returns"):
            _, _, desc = line.partition(":")
            return_doc = {"type": "unknown", "description": desc.strip()}
            continue
        if line.startswith(":rtype:"):
            typ = line[len(":rtype:"):].strip()
            return_doc = {"type": normalize_type_name(typ), "description": return_doc["description"] if return_doc else ""}
            continue

        if block == "params":
            name_part, _, desc = line.partition(":")
            if name_part and desc:
                if "(" in name_part and ")" in name_part:
                    name = name_part.split("(", 1)[0].strip()
                    typ = name_part.split("(", 1)[1].split(")", 1)[0].strip()
                else:
                    name = name_part.strip()
                    typ = ""
                if name:
                    item = param_docs.setdefault(name, {})
                    item["description"] = desc.strip()
                    if typ:
                        item["type"] = normalize_type_name(typ)
            continue

        if block == "returns" and return_doc is None:
            return_doc = {"type": "unknown", "description": line}

    return param_docs, return_doc


def build_params(fn_node, doc_param_contracts):
    params = []
    positional = list(fn_node.args.posonlyargs) + list(fn_node.args.args)
    defaults = [None] * (len(positional) - len(fn_node.args.defaults)) + list(fn_node.args.defaults)

    def add_arg(arg, default_node, kind):
        annotation_contract = contract_from_annotation(arg.annotation)
        contract = apply_default_type(annotation_contract, default_node)
        doc_contract = doc_param_contracts.get(arg.arg, {})
        if doc_contract.get("type") and contract.get("type") == "unknown":
            contract["type"] = doc_contract["type"]
        if doc_contract.get("description"):
            contract["description"] = doc_contract["description"]
        params.append({
            "name": arg.arg,
            "type": contract.get("type", "unknown"),
            "required": default_node is None and kind != "vararg" and kind != "kwarg",
            "index": len(params),
            "kind": kind,
            **({"description": contract["description"]} if contract.get("description") else {}),
            **({"schema": contract["schema"]} if contract.get("schema") else {}),
            **({"items": contract["items"]} if contract.get("items") else {}),
        })

    for arg, default_node in zip(positional, defaults):
        add_arg(arg, default_node, "positional")

    if fn_node.args.vararg:
        contract = contract_from_annotation(fn_node.args.vararg.annotation)
        params.append({
            "name": fn_node.args.vararg.arg,
            "type": "array" if contract.get("type") == "unknown" else contract.get("type"),
            "required": False,
            "index": len(params),
            "kind": "vararg",
        })

    for arg, default_node in zip(fn_node.args.kwonlyargs, fn_node.args.kw_defaults):
        add_arg(arg, default_node, "keyword_only")

    if fn_node.args.kwarg:
        contract = contract_from_annotation(fn_node.args.kwarg.annotation)
        params.append({
            "name": fn_node.args.kwarg.arg,
            "type": "object" if contract.get("type") == "unknown" else contract.get("type"),
            "required": False,
            "index": len(params),
            "kind": "kwarg",
        })

    return params


def get_function_entry(node):
    docstring = ast.get_docstring(node) or ""
    doc_params, doc_return = parse_doc_contracts(docstring)
    param_contracts = build_params(node, doc_params)
    return_contract = contract_from_annotation(node.returns)
    if return_contract.get("type") == "unknown" and doc_return:
        return_contract = doc_return
    elif doc_return and doc_return.get("description"):
        return_contract["description"] = doc_return["description"]

    return {
        "exportName": node.name,
        "type": "function",
        "async": isinstance(node, ast.AsyncFunctionDef),
        "params": [item["name"] for item in param_contracts],
        "paramContracts": param_contracts,
        "returnContract": return_contract,
        "doc": docstring,
    }


def get_class_entry(node):
    return {
        "exportName": node.name,
        "type": "class",
        "params": [],
        "paramContracts": [],
        "returnContract": {"type": node.name},
        "doc": ast.get_docstring(node) or "",
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Missing file path"}))
        return

    file_path = sys.argv[1]
    try:
        with open(file_path, "r", encoding="utf-8") as handle:
            source = handle.read()
        tree = ast.parse(source, filename=file_path)
        entries = []
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                entries.append(get_function_entry(node))
            elif isinstance(node, ast.ClassDef):
                entries.append(get_class_entry(node))
        print(json.dumps({"ok": True, "exports": entries}))
    except SyntaxError as err:
        print(json.dumps({"ok": False, "error": f"SyntaxError: {err.msg}"}))
    except Exception as err:
        print(json.dumps({"ok": False, "error": str(err)}))


if __name__ == "__main__":
    main()
