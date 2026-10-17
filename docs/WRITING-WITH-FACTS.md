# Writing with facts — the interface spec

*For whoever builds the UI. The service layer behind every screen here is built
and tested; this is what it should look like and, more importantly, what it
should feel like.*

---

## The problem this solves

RaiseRoom refuses to let a figure be typed into a document. Every number has to
resolve from a confirmed fact. **That rule is not negotiable and is not up for
softening** — it is the entire reason a reader can stop checking a deck against
the accounts.

But a rule is only half a product. The first version of this refused the
sentence, explained the policy, and stopped. The writer was then expected to
leave what they were writing, find a form somewhere else, invent a key, and come
back to a sentence whose thread they had lost. People do not do that. They write
the deck somewhere else and paste it in.

So the rule stays and the work goes. **The product does the typing.**

---

## The core insight

Most of the time, the figure is already there.

A founder writing "revenue reached $4.2m" has that number because it is in their
accounts, which they have already uploaded and confirmed. The correct response is
not *record this as a fact*. It is:

> **That's your TTM revenue.** Insert it → *(it'll stay right when the figure is updated)*

One click. Nothing created. The sentence is now better than what they typed,
because it will correct itself when the fact does.

Design everything around this being the common case. The "create a new fact" path
must exist and must be good, but if the interface treats both as equally likely,
it will feel like a form even when it isn't one.

---

## The four states of a sentence

### 1. Clean

Every figure is a reference. No interruption, no badge, no celebration. Writing
that follows the rule should feel like ordinary writing.

### 2. A figure that already exists

The writer typed `$4.2m`. A confirmed fact holds 4,200,000.

```
Revenue reached $4.2m last year.
                ~~~~~
```

An inline affordance, not a modal:

> **$4.2m** — you already have this
> **Revenue, trailing twelve months** · Financials · confirmed from accounts.pdf p.4
> [ Insert reference ]  [ It's something else ]

"It's something else" matters. The figure may genuinely be a different thing that
happens to share a value, and an interface that assumes otherwise will eventually
put the wrong fact in somebody's deck. Choosing it falls through to state 3.

**API:** `checkAndRepair` → `repairs[].matches[]`, each with `replace_with`.
Applying it is `recordAndInsert` with `use_existing: true`.

### 3. A figure that doesn't exist yet

The writer typed `63.9%`. Nothing matches.

Do not show an empty form. Show a **filled-in draft**:

> **63.9%** — not recorded yet
> Name: `Gross margin` *(editable)*
> Key: `financials.gross_margin` *(editable, collapsed by default)*
> Value: `63.9` Unit: `percent`
> [ Save and insert ]  [ Cancel ]

The label comes from the words in front of the figure, the unit from how it was
written, the key from the label. The writer is confirming a draft, not filling in
a form — that difference is most of the perceived effort.

**Never guess a unit that the notation didn't state.** A bare `34` gets
`needs: ['unit']` and the unit field is the one thing focused. Inventing "USD" for
it would put a property on the fact that the user never asserted, which is the
same class of error as inventing the figure, just smaller.

**API:** `checkAndRepair` → `repairs[].draft`, then `recordAndInsert` with it.
One call creates the fact and returns the repaired sentence.

### 4. Several figures

Repair them one at a time, in document order, and say what is left:

> *That one's sorted — two more in this paragraph.*

`recordAndInsert` returns `ok: false` and the remaining `problems` when there is
more to do, so the interface can keep its place rather than re-running the check.

---

## Typing a reference directly

`{{` opens the fact picker. This is the path a fluent user ends up on, and it
should be fast:

- Matches **key and label**, because a writer thinks "gross margin" and the key
  is `financials.gross_margin`. Requiring them to know the key makes the syntax
  something to memorise.
- Shows the group and a value preview, so the right one is identifiable at a
  glance.
- **Only ever offers usable facts.** An unconfirmed extraction inserted here
  renders as a blank in the finished document.
- The last item is always **"+ Record a new fact"**, which opens the same drafting
  surface as state 3 with the label field focused.

**API:** `suggestFacts(ctx, orgId, prefix)` → `suggestions[].insert`.

---

## The fact library

Reachable from everywhere — a sidebar in the writing surface, a page of its own,
and the picker above. Someone looking for "that revenue figure" wants it under a
heading they recognise, next to the others like it.

- **Grouped** under the eight headings in `KEY_GROUPS` — Financials, Customers
  and contracts, People, and so on. A flat alphabetical list is a correct answer
  to a question nobody asks.
- **Search needs every word.** "margin trailing" matching a fact that mentions
  only margin is a search that wastes a click.
- **Usage counts.** A fact used in four documents is one you think twice about
  superseding. A fact used nowhere is a candidate for tidying.
- **"Awaiting confirmation" is a section, not a filter.** It is the commonest
  reason a writer is told that a figure they can see on screen cannot be used, and
  burying it turns that into a support ticket. Each entry carries
  `why_not_usable` in words, because `DOCUMENT_EXTRACTED` means nothing to the
  person who uploaded the file.
- **Adding a fact is available from the library itself**, not only from a refused
  sentence.

**API:** `factLibrary(ctx, orgId, { query, group })`.

---

## Say it before they hit it

The rule is easy to accept as an explanation of how writing here works, and
irritating to meet as an error. Put `writingGuide` copy at the top of an empty
writing surface:

> **Write the sentence. Pick the figure.**
> Type `{{` wherever a number goes and choose from your facts. The document fills
> in the value when it renders, at the right precision — and if that figure is
> later corrected, every document carrying it corrects itself.

And the empty state, which needs the most care, because a writer with no facts
yet should be told what to do rather than shown an empty list:

> You have no confirmed facts yet, so there is nothing to reference. Upload your
> accounts and confirm what the extractor finds, or record a figure by hand —
> either way it takes a minute and then every document can use it.

---

## Tone

Four things to hold to, because the difference between this feeling like a
guardrail and a nuisance is almost entirely wording.

**Never scold.** The writer did a normal thing. "Revenue reached $4.2m" is how
people write. The interface's job is to finish the job, not to mark the work.

**Lead with the benefit, not the rule.** "It'll stay right when this figure is
updated" is true, immediately useful, and the actual reason to prefer a
reference. "Figures must be traceable" is a policy, and policies are read once
and resented after.

**Never show a raw key as the primary label.** `financials.gross_margin` is
plumbing. "Gross margin · Financials" is the fact. The key is editable, under a
disclosure, for the people who care.

**Say what is happening to provenance.** A figure typed into a sentence is
recorded `USER_ENTERED` — the writer asserts it. A figure confirmed against an
uploaded document is `USER_CONFIRMED` — a document evidences it. These are not
the same and the interface should not blur them: the second is worth more in a
data room, and a writer who knows that will go and attach the document.

---

## What the service layer gives you

| Call | For |
|---|---|
| `writingGuide` | The copy above, plus the empty state and a usable-fact count |
| `factLibrary` | Grouped, searchable, with usage counts and the awaiting-confirmation section |
| `suggestFacts` | The `{{` picker. Usable facts only |
| `checkAndRepair` | Live checking. Returns problems **and** a repair for each |
| `recordAndInsert` | Create the fact and repair the sentence, in one call |
| `previewProse` | Check without writing |
| `writeProse` | Save. Supersedes rather than overwrites |

Every one of them is authorised, org-scoped, and tested. `recordAndInsert` goes
through the ordinary fact service, so there is no shortcut path that writes a
fact row — every rule that applies to a fact applies to one created this way.

---

## What must not be built

**No override.** No "insert anyway", no "I know what I'm doing", no admin
setting. The moment one document contains a typed figure, the claim printed on
every document in the product becomes something a reader has to verify, which is
the thing they were buying their way out of.

**No auto-creating facts from prose without confirmation.** The draft is offered;
a person saves it. A product that silently created facts from whatever someone
typed would be laundering typed numbers into provenance, which is worse than
allowing typed numbers honestly.

**No "confirmed" status for a figure typed in a sentence.** It is `USER_ENTERED`.
Confirmation is a statement about a document, and there is no document in this
flow.
