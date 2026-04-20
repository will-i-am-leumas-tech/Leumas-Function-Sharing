import asyncio
import dataclasses
import importlib.util
import inspect
import json
import os
import sys
import traceback


def emit(payload):
    sys.stdout.write(json.dumps(payload))


def module_name_from_payload(payload):
    if payload.get("moduleName"):
        return payload["moduleName"]
    base = os.path.splitext(os.path.basename(payload["modulePath"]))[0]
    return f"_leumas_mesh_{base}"


def import_module(payload):
    module_path = os.path.abspath(payload["modulePath"])
    project_root = payload.get("projectRoot")
    module_dir = os.path.dirname(module_path)

    candidates = [project_root, module_dir]
    if project_root:
        current = module_dir
        root = os.path.abspath(project_root)
        while current and os.path.abspath(current).startswith(root):
            candidates.append(current)
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent

    for candidate in candidates:
        if candidate:
            resolved = os.path.abspath(candidate)
            if resolved not in sys.path:
                sys.path.insert(0, resolved)

    spec = importlib.util.spec_from_file_location(module_name_from_payload(payload), module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load Python module")

    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def to_jsonable(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple, set)):
        return [to_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if dataclasses.is_dataclass(value):
        return to_jsonable(dataclasses.asdict(value))
    if hasattr(value, "model_dump") and callable(value.model_dump):
        return to_jsonable(value.model_dump())
    if hasattr(value, "dict") and callable(value.dict):
        return to_jsonable(value.dict())
    return repr(value)


async def maybe_await(value):
    if inspect.isawaitable(value):
        return await value
    return value


async def run(payload):
    module = import_module(payload)
    export_name = payload.get("exportName")
    target = getattr(module, export_name, None)
    if not callable(target):
        return {"ok": False, "error": f"Export {export_name} is not a function"}

    result = target(*(payload.get("args") or []))
    result = await maybe_await(result)
    return {"ok": True, "result": to_jsonable(result)}


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "Missing payload"})
        return

    try:
        payload = json.loads(sys.argv[1])
        emit(asyncio.run(run(payload)))
    except Exception as err:
        emit({
            "ok": False,
            "error": str(err),
            "traceback": traceback.format_exc(limit=5),
        })


if __name__ == "__main__":
    main()
