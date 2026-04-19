# Spell Engine Mode (-wf, --workflow)

When `-wf` is used, the /flo skill switches to the generalized spell engine
instead of the hardcoded coding process. This uses the `Grimoire` from
`@moflo/spells` to resolve and run YAML/JSON spell definitions.

## Scan Directories (in priority order)

1. Shipped: `src/modules/spells/definitions/` (bundled with moflo)
2. User: `spells/` and `.claude/spells/` (project-level overrides)

## Registry Behavior

- Each spell file defines `name` and optional `abbreviation` in frontmatter
- Registry builds lookup map: abbreviation -> file path, full name -> file path
- Duplicate abbreviations produce a collision error on load
- User definitions override shipped ones by name match

## Subcommands

`/flo -wf list` — List all available spells:
```
Use Grimoire.list() to get all registered spells.
Print a table: name | abbreviation | description | tier (shipped/user)
```

`/flo -wf info <name|abbreviation>` — Show spell details:
```
Use Grimoire.info(query) to get detailed info.
Print: name, abbreviation, description, version, source file, arguments, step count, step types
```

`/flo -wf <name|abbreviation> [positional-args] [--named-args]` — Execute a spell:
```
1. Use Grimoire.resolve(wfName) to find the spell
2. Map positional args to required arguments in order
3. Parse named args: --key=value or --key value
4. Use runSpellFromContent() or createRunner().run() to execute
5. Print step-by-step progress and final result
```

## Argument Mapping

- Positional args mapped to required arguments in definition order
- Named args: `--severity=critical` or `--severity critical`
- Boolean flags: `--autofix` (true if present)
- Example: `/flo -wf sa ./src --severity critical --autofix`
  Maps to: `{ target: "./src", severity: "critical", autofix: "true" }`
