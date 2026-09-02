# Unlisted — Safety

Rewritten for the public-venue model. Two earlier assumptions are gone: address secrecy, and the idea that screening filters intent.

## The standard

No admissions system filters for intent. Controls that stop an opportunist do not stop someone who arrives with a plan. The realistic goals are **reducing opportunity**, **making consequences certain**, and **responding competently**.

Language discipline: *accountable*, *verified*, *never alone*. Never *safe*.

**Abort condition, decided now:** a serious incident pauses all upcoming plans in the affected district, triggers a written review within 72 hours, and no resumption until the specific failure has a mechanism attached.

## What the public-venue decision already bought

More than any feature could. A licensed venue supplies lighting, staff, cameras, other patrons, and an operator whose licence is at risk. That removes opportunity rather than attempting to detect intent, which is the only category of control that works against a determined person.

It also deletes the entire address-protection subsystem — reveal ladders, release timing, revocation, keeping addresses out of logs and notifications. That machinery was the most security-sensitive part of the earlier design and it no longer exists.

## Where risk actually remains

Three places. Everything below targets them.

**1. Transitions.** Harm concentrates at movement: the change of venue, the walk to transport, the journey home. This is now the primary risk surface and the product should be designed against it directly.

**2. The unscreened majority.** You verify the applicants. The host circle's own friends, the venue's other patrons, and everyone else in the room are outside your system. An applicant is protected from other applicants and not from anyone else present. This is a real limit, it cannot be closed, and it should be stated internally rather than papered over.

**3. The host circle.** Every control points at applicants, but the host circle chooses the venue, sets the tone, decides who stays, and — because they are verified with a visible record — arrives pre-trusted. Treat host circles as monitored, not trusted.

## Controls, by cost to the user

### Structural — nobody sees these

- **Registered public venues only.** No private residences, in any category, at any time.
- **Minimum group sizes on both sides.** The applicant never arrives alone and never arrives into a pair.
- **Host circle must be present and confirmed.** A plan cannot publish with an unconfirmed host circle, so the people who invited you actually show up.
- **Graduated hosting.** A circle's first plans are capped in size, and daytime or early-evening venues come before late-night ones. Late hosting is earned through a clean record.
- **Total size caps** where outside guests are present. A 40-person room with a named host circle is a different risk object from a 150-person one.
- **Composition rules** written down and published: what may constrain the outside allocation, and what may never be used as a parameter. Turkish nightlife door policy already runs on gender ratios and promoter economics; a platform that formalises admission is one decision from becoming promoter infrastructure. The written rules are what prevent that.

### Passive — silent, no user action

- **Verified identity, held and never displayed.** Its value is ban durability and traceability, not screening. Bans attach to identity, not to accounts.
- **Records on both sides.** Applicants see the host circle's history — plans run, whether guests return. Hosts see applicant reliability. Disclosure is symmetric, because the person deciding whether to join a stranger's table at 23:00 needs it more than the host needs a bio.
- **Non-return detection.** A host circle whose outside guests never come back is a signal that requires no report to be filed. This is the highest-yield passive signal available and it catches what underreporting hides.
- **Co-occurrence analysis.** The same person repeatedly paired with first-time attendees who never return.
- **Bidirectional blocking**, applied in the query layer, invisible to both parties.

### Ambient — rides on steps users already take

- **The plan card is the arrival artefact.** It carries venue, time, the confirmed group, and transport options. No separate check-in ritual.
- **Share with a friend**, offered on the plan card. Framed as convenience, functions as an outside observer.
- **Departure is a group action.** End-of-plan prompts go to the circle, not the individual. The default trajectory is group-shaped, because that is where transitions go wrong.
- **A frictionless exit.** One tap that summons a ride and gives someone a socially costless reason to leave. Being able to leave without an accusation protects more than any badge.
- **The morning-after question.** One question to every attendee, private, behaviourally specific rather than "was there a problem." It doubles as a low-threshold report channel and a wellbeing check. Silence from someone whose circle also went quiet is itself a signal.
- **No contact by default afterwards.** We introduced these people; the post-event contact risk is ours to answer.

### Active — rare, staffed, visible only in incidents

- **A route to a real human during the event window.** A help button with nobody behind it is worse than none, because it manufactures false confidence.
- **On-call coverage during every event window.** If it cannot be staffed, night plans do not run. This caps launch scale, and that is the intended effect.
- **Written escalation path** with a named responsible person and the authority to cancel a plan in progress.
- **Emergency disclosure procedure** decided in advance, not improvised at 04:00.
- **Silent enforcement.** Signals accumulate; parties stop being surfaced to each other; nobody is notified or accused. Formal action exists for serious cases.

## Reporting that survives underreporting

The morning-after prompt assumes people file, and the people at greatest risk file least. So the system cannot depend on it.

- **Ask the circle, not only the individual.** Third-party observation is the highest-yield channel in every system that has measured it.
- **Ask behaviourally specific questions.** "Did anyone make someone uncomfortable?" outperforms "was there a problem."
- **Weight patterns, not incidents.** Three soft signals from unrelated events outrank one loud complaint.
- **Run detection that needs no report at all** — non-return, early departure, co-occurrence.

## Escalation

1. **Soft signal** — low feedback, declined repeat, early departure, no-show.
2. **Pattern** — signals across unrelated plans and unrelated reporters.
3. **Quiet action** — reduced visibility, removal from a circle's pool, loss of hosting privileges, size or time restrictions.
4. **Formal action** — suspension, identity-level ban, escalation to authorities, evidence retained.

## Deliberately not doing

- Badges that only mean an email was confirmed
- Public ratings of individuals, which create retaliation and suppress the reports we need
- Background checks, unreliable in this market and useless against first-time offenders
- Panic buttons with no operator
- Any claim that a plan is safe

## Metrics

- Unattached arrival rate — must be zero
- Signals per 100 attendees, by venue type and hour
- Non-return rate by host circle
- Post-event response rate — a falling rate means the channel is dying
- Time to first human response during an event window
- Repeat attendance by women, as the clearest revealed-preference signal that this is working

## Open decisions

- The minimum group sizes
- Minimum on-call staffing, and the plan-per-night cap it implies
- Published list of permitted and prohibited composition parameters
- Signal thresholds for quiet action, and who reviews them
- Whether late-night venue categories run at all in year one
