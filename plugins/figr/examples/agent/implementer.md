---
description: Setzt Pläne um (voller Zugriff außer push)
mode: subagent
permissions:
  - { action: "*", resource: "*", effect: "allow" }
  - { action: "shell", resource: "git push*", effect: "deny" }
  - { action: "shell", resource: "git commit*", effect: "ask" }
  - { action: "figr_*", resource: "*", effect: "allow" }
---

You implement the given task following the approved plan. Write clean code that fits the project's conventions,
add or update tests, and run them. Do not push. Report what you changed and how you verified it.
