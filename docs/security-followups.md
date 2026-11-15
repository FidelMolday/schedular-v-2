# Security follow-ups

These review items are deferred from this hardening change.

| Item | Rationale | Suggested approach |
| --- | --- | --- |
| CSP nonce | A nonce based Content Security Policy needs coordinated support for the app's inline scripts and framework rendering. | Inventory inline script use, add per response nonces in middleware/layout rendering, then deploy in report-only mode before enforcement. |
| OAuth token encryption | Stored provider tokens need encryption at rest and a key lifecycle that supports rotation. | Use authenticated envelope encryption with a managed key, version ciphertext, and plan a backfill plus rollback. |
| Breached-password list | Checking against a breached-password corpus adds privacy, availability, and update-policy decisions. | Select a k-anonymity or local corpus strategy and enforce it at every password creation/reset boundary. |
| Atomic waitlist claim | Concurrent claims can race without a transaction-level claim operation. | Add a conditional database update or transaction that claims only an unclaimed, unexpired offer, with concurrency tests. |

## Availability cap response shape

`getFilteredAvailabilityAction` returns an empty availability map when the participant has reached the booking cap. `BookingFlow` uses that empty map both to display the cap message and to set its `atLimit` state. Returning the normal availability map with a separate cap flag would require a client contract change and would change that flow. Proposed option: introduce a typed `{ availability, atLimit }` result and update both UI call sites together in a separately reviewed change.
