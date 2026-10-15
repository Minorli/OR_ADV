#!/usr/bin/env python3
"""Validate local design links, contract references, and fictional fixture consistency."""
from pathlib import Path
from collections import Counter
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit
import json
import re
import sys

class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links=[]
    def handle_starttag(self, tag, attrs):
        for name,value in attrs:
            if name in ("href","src") and value:
                self.links.append(value)

def validate(root):
    errors=[]
    objects={}
    for path in root.rglob("*.json"):
        if any(p in ("node_modules",".git","work","dist","coverage","oradv-linux-handoff-v1.0.0") for p in path.relative_to(root).parts):
            continue
        try:
            objects[path.relative_to(root).as_posix()]=json.loads(path.read_text(encoding="utf-8"))
        except (ValueError,UnicodeError):
            errors.append("invalid JSON: "+path.relative_to(root).as_posix())
    for path in list(root.glob("*.md"))+list((root/"docs").glob("*.md"))+list((root/"references").glob("*.html")):
        content=path.read_text(encoding="utf-8")
        if path.suffix==".html":
            parser=Links()
            parser.feed(content)
            links=parser.links
        else:
            links=re.findall(r"\[[^\]]*\]\(([^)\s]+)\)",content)
        for link in links:
            if link.startswith(("#","data:","mailto:","tel:","javascript:")):
                continue
            parsed=urlsplit(link)
            if parsed.scheme or parsed.netloc:
                continue
            target=path.parent/unquote(parsed.path)
            if parsed.path and not target.exists():
                errors.append("broken local link: "+path.relative_to(root).as_posix()+" -> "+link)
    try:
        states=objects["contracts/states.json"]
        allowed=set(states["registration"])
        for source,targets in states["registrationTransitions"].items():
            if source not in allowed or not set(targets)<=allowed:
                errors.append("unknown transition state")
        fixture=objects["fixtures/demo.json"]
        if fixture.get("fixtureOnly") is not True or fixture.get("allowProductionImport") is not False:
            errors.append("fixture production boundary missing")
        members={m["id"] for m in fixture["members"]}
        activities={a["id"]:a for a in fixture["activities"]}
        seats=Counter()
        pairs=set()
        for reg in fixture["registrations"]:
            pair=(reg["activityId"],reg["memberId"])
            if pair in pairs: errors.append("duplicate fixture registration")
            pairs.add(pair)
            if reg["memberId"] not in members or reg["activityId"] not in activities:
                errors.append("fixture reference missing")
            if reg["state"] not in allowed: errors.append("fixture state missing")
            if reg["seatState"]=="held": seats[reg["activityId"]]+=1
        for ident,a in activities.items():
            if not 0<=a["reservedSeats"]<=a["capacity"] or seats[ident]!=a["reservedSeats"]:
                errors.append("fixture capacity mismatch: "+ident)
        banned={"price","amount","payment","paymentstatus","paid","refund","fee","orderid"}
        def scan(value):
            if isinstance(value,dict):
                for key,child in value.items():
                    if key.lower() in banned: errors.append("out-of-scope financial fixture field")
                    scan(child)
            elif isinstance(value,list):
                for child in value: scan(child)
        scan(fixture)
        api=objects["contracts/api-contract.json"]
        names=[a["action"] for a in api["actions"]]
        if len(names)!=len(set(names)): errors.append("duplicate RPC action")
        if objects["PROJECT_STATUS.json"]["nativeAppImplemented"] is False and (root/"app"/"miniprogram"/"app.js").exists():
            errors.append("Update PROJECT_STATUS: native files now exist")
    except (KeyError,TypeError) as exc:
        errors.append("required contract/fixture key missing: "+str(exc))
    return errors

def main():
    root=Path(__file__).resolve().parents[1]
    errors=validate(root)
    for item in errors: print(item,file=sys.stderr)
    if errors: return 1
    print("PASS: local links, JSON contracts, and fictional fixture references.")
    print("No network/cloud access or product acceptance test was performed.")
    return 0

if __name__=="__main__":
    raise SystemExit(main())
