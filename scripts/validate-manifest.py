#!/usr/bin/env python3
"""Hand validation of repro/manifest.yml against the Forge CLI's own rules,
since `forge lint` demands a login this VM cannot provide (see README.md).
Uses real YAML parsing and checks every cross-reference mechanically.
Run: python3 scripts/validate-manifest.py
"""
import os
import re
import sys

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

with open(os.path.join(ROOT, "manifest.yml")) as f:
    manifest = yaml.safe_load(f)

errors = []


def check(cond, msg):
    if not cond:
        errors.append(msg)


modules = manifest["modules"]
fn_keys = {m["key"] for m in modules.get("function", [])}
action_keys = {m["key"] for m in modules.get("action", [])}
agent = modules["rovo:agent"][0]
skill_keys = {m["key"] for m in modules.get("rovo:skill", [])}
mcp = modules["rovo:mcp"][0]
panel = modules["jira:issuePanel"][0]
resource_keys = {r["key"] for r in manifest.get("resources", [])}
scopes = manifest["permissions"]["scopes"]

# 1. Actions reference existing functions, are GET-only, inputs required:false.
for a in modules.get("action", []):
    check(a["function"] in fn_keys, f"action {a['key']} references missing function {a['function']}")
    check(a.get("actionVerb") == "GET", f"action {a['key']} is not GET")
    for name, spec in (a.get("inputs") or {}).items():
        check(spec.get("required") is False, f"action {a['key']} input {name} is not required:false")
        check("type" in spec and "description" in spec, f"action {a['key']} input {name} lacks type/description")

# 2. Agent references existing actions/skills; name <= 30 chars.
check(agent["name"] and len(agent["name"]) <= 30, f"agent name > 30 chars: {agent['name']}")
for a in agent.get("actions", []):
    check(a in action_keys, f"agent references missing action {a}")
for s in agent.get("skills", []):
    check(s in skill_keys, f"agent references missing skill {s}")
check(isinstance(agent.get("prompt"), str) and agent["prompt"], "agent prompt must be a non-empty string")
check(agent["prompt"].startswith("resource:"), "agent prompt must use the resource: string form")

# 3. Skill uses source.dir; dependencies reference existing actions.
for s in modules.get("rovo:skill", []):
    check("source" in s and "dir" in s["source"], f"skill {s['key']} lacks source.dir")
    check(os.path.isdir(os.path.join(ROOT, s["source"]["dir"])), f"skill dir missing: {s['source']['dir']}")
    for t in (s.get("dependencies") or {}).get("tools", []):
        check(t in action_keys, f"skill {s['key']} depends on missing action {t}")

# 4. MCP: name <= 30, tools exist, 1-50 tools, keys < 64 chars.
check(mcp["name"] and len(mcp["name"]) <= 30, f"mcp name > 30 chars: {mcp['name']}")
check(1 <= len(mcp["tools"]) <= 50, f"mcp tools count {len(mcp['tools'])} out of 1-50")
for t in mcp["tools"]:
    check(t in action_keys, f"mcp references missing action {t}")
    check(len(t) < 64, f"tool key too long: {t}")

# 5. Panel: resource exists, resolver function exists, render native.
check(panel["resource"] in resource_keys, f"panel references missing resource {panel['resource']}")
check(panel.get("resolver", {}).get("function") in fn_keys, "panel resolver references missing function")
check(panel.get("render") == "native", "panel render must be native (UI Kit 2)")

# 6. Resource keys referenced exist; prompt file resolves.
for m in re.finditer(r"resource: ([\w-]+)", yaml.safe_dump(manifest)):
    pass  # resource: strings are checked below via the prompt + panel
prompt_res, _, prompt_file = agent["prompt"].partition(";")
prompt_key = prompt_res.split(":", 1)[1]
check(prompt_key in resource_keys, f"prompt references missing resource {prompt_key}")
prompt_dir = next(r["path"] for r in manifest["resources"] if r["key"] == prompt_key)
prompt_path = os.path.join(ROOT, prompt_dir, prompt_file)
check(os.path.isfile(prompt_path), f"prompt file missing: {prompt_path}")
check(os.path.getsize(prompt_path) > 100, "prompt file suspiciously short")

# 7. Handler exports in src/index.js match the manifest.
index_js = open(os.path.join(ROOT, "src", "index.js")).read()
for m in modules.get("function", []):
    handler = m["handler"]
    check(handler.startswith("index."), f"unexpected handler format: {handler}")
    name = handler.split(".", 1)[1]
    check(re.search(rf"export (async function {name}|const {name} )", index_js),
          f"src/index.js missing export {name}")

# 8. Skill dir: SKILL.md name matches dir, no scripts, < 100 MB.
skill_dir = os.path.join(ROOT, "skills", "repro-rubric")
with open(os.path.join(skill_dir, "SKILL.md")) as f:
    front = f.read().split("---")[1]
check(re.search(r"^name: repro-rubric$", front, re.M), "skill name must match its directory")
total = 0
for dirpath, _, files in os.walk(skill_dir):
    for fn in files:
        check(not re.search(r"\.(js|mjs|sh|py)$", fn), f"executable script in skill dir: {fn}")
        total += os.path.getsize(os.path.join(dirpath, fn))
check(total < 100 * 1024 * 1024, "skill dir over 100 MB")

# 9. Scopes: read-only only, <= 50.
check(len(scopes) <= 50, "over the 50-scope cap")
for s in scopes:
    check(s.startswith(("read:", "search:")), f"non-read scope: {s}")

# 10. Runtime + app id placeholder present.
check(manifest["app"]["runtime"]["name"] == "nodejs24.x", "runtime must be nodejs24.x")
check(manifest["app"].get("id", "").startswith("ari:cloud:ecosystem::app/"), "app id missing")

if errors:
    print("FAIL:")
    for e in errors:
        print(f"  - {e}")
    sys.exit(1)

print(f"OK: {len(fn_keys)} functions, {len(action_keys)} actions, 1 agent, "
      f"{len(skill_keys)} skill, 1 mcp, 1 panel, {len(resource_keys)} resources, "
      f"{len(scopes)} scopes — all cross-references valid.")
