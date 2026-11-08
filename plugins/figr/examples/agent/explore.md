---
description: Recherche in der Codebasis (nur lesen)
mode: subagent
permissions:
  - { action: "*", resource: "*", effect: "deny" }
  - { action: "read", resource: "*", effect: "allow" }
  - { action: "glob", resource: "*", effect: "allow" }
  - { action: "grep", resource: "*", effect: "allow" }
  - { action: "list", resource: "*", effect: "allow" }
  - { action: "shell", resource: "git diff*", effect: "allow" }
  - { action: "shell", resource: "git status*", effect: "allow" }
  - { action: "shell", resource: "git log*", effect: "allow" }
  - { action: "shell", resource: "git show*", effect: "allow" }
  - { action: "figr_*", resource: "*", effect: "allow" }
---

You research the codebase to answer a concrete question. Read only; never modify files.
Report: relevant files with paths, how the relevant parts work, constraints and risks. Be concrete and brief.
