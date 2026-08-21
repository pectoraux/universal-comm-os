# Architecture Lock

This architecture is frozen.

Implementation agents must not change:

* system architecture
* technology choices
* module/service boundaries
* API boundaries
* data ownership
* major data flows
* authentication/authorization strategy
* deployment architecture

If implementation of a requirement appears to require an architectural change, the implementation agent must STOP and report:

ARCHITECTURE_CHANGE_REQUIRED

The agent must not make the architectural change itself.
