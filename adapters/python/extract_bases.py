"""Extract class inheritance from Python source files using the ast module.

Usage: python3 extract_bases.py <file1> <file2> ...

Output: one JSON object per class (JSONL), e.g.:
  {"file":"mypackage/service.py","line":11,"class":"HelloService","bases":["Greeter"]}

Only classes with at least one base class are emitted.
Bases are reduced to their simple name (last component of dotted names).
Parameterized bases like Generic[T] are stripped to the base name.
Keyword arguments (metaclass=...) are excluded.
"""

import ast
import json
import sys


def extract_bases(filepath: str) -> list[dict]:
    with open(filepath) as f:
        source = f.read()
    tree = ast.parse(source, filename=filepath)

    results = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue

        bases: list[str] = []
        for base in node.bases:
            name = _base_name(base)
            if name:
                bases.append(name)

        if bases:
            results.append(
                {
                    "file": filepath,
                    "line": node.lineno,
                    "class": node.name,
                    "bases": bases,
                }
            )
    return results


def _base_name(node: ast.expr) -> str | None:
    """Extract the simple class name from a base class AST node."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        # e.g. module.ClassName -> ClassName
        return node.attr
    if isinstance(node, ast.Subscript):
        # e.g. Generic[T] -> Generic
        return _base_name(node.value)
    return None


def main() -> None:
    for filepath in sys.argv[1:]:
        try:
            for entry in extract_bases(filepath):
                print(json.dumps(entry))
        except SyntaxError:
            pass


if __name__ == "__main__":
    main()
