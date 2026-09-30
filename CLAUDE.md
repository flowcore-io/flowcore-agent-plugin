# Agent instructions for this repository

- This repo is the source of the Flowcore agent skills. The Flowcore frontend mirrors a tagged release at https://flowcore.io/agent/skills/.
- Do not add real tenant, data core, or user identifiers. Use `acme` and the example UUID in CONTRIBUTING.md.
- FRNs in code blocks must be valid: `frn::<tenant-name>:<type>/<uuid|*>`, lowercase actions. The validator enforces this.
- Run the validator and its self-test before you commit.
