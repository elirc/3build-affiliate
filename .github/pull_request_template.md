<!--
Fill this in. Do not delete sections; write "n/a" if one genuinely does not
apply. Every section is here because a reviewer needed it and had to ask.
-->

## What

<!-- One or two sentences. What does this PR make possible that wasn't before? -->

## Why

<!--
The problem, not the solution. If it fixes a bug, describe the failure a user
would see. If it implements a story, link it: fabledocs/02-user-stories.md US-XX
-->

## How

<!-- The shape of the change. Call out anything a reviewer would not guess. -->

## Trade-offs

<!--
Where you chose between viable options, say which and what it costs. If you
took a shortcut, name it here rather than letting a reviewer find it.
"None" is almost never true.
-->

## How to verify

<!-- Exact commands and expected output. Assume the reviewer has a clean checkout. -->

```bash
npm run test
```

## Risk

<!--
What could this break? What did you deliberately leave alone? Any migration
that is not backwards compatible, any behaviour change existing clients would
notice.
-->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run test` passes
- [ ] New behaviour has tests
- [ ] Input validated with a Zod schema in `packages/shared`
- [ ] Authorization enforced in a service, not just a route or the UI
- [ ] No new `any`
- [ ] `fabledocs/` updated if this makes the docs wrong
