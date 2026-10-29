# D09: A suite must separate skill from no skill before its version verdicts count

- Date, owner: 2026-10-29, Mateusz Minkiewicz (maintainer)
- Context and the options weighed: the first real D03 check
  ([run log](../../../runs/2026-10-29-d03-check-wp-block-development.md)) ran
  WordPress/agent-skills `wp-block-development` v3 against v2 and against no skill with Claude Code
  (`claude-opus-5-5`, 24 sessions). Both runs were `Unstable` with a delta of about 0. The model
  already did everything the suite checked, also without the skill (a ceiling effect). A version
  verdict from such a suite says nothing about the revision. The agent proposed making
  discrimination a precondition, and the maintainer accepted. The alternative was to judge
  version verdicts directly, which would count a suite that measures nothing as evidence for or
  against D03.
- Decision and why: for D03, a version-against-version verdict (A/B) counts only when the same
  suite, on the same agent profile, first shows a measurable difference between the skill and no
  skill (`--baseline none`). A suite that cannot tell the skill from its absence is too easy, or
  grades the wrong thing. It must be changed before its version verdicts are used.
- Consequences, and what would make us revisit it: a D03 observation needs a `none` run per
  suite before the A/B runs. The precise discrimination threshold is not set yet. Q05 stays open
  for the rest: what counts as a confirmed outcome, how many skill updates, over what period, and
  what agreement means continue or stop. A human comparison also needs the agent's output files,
  which DirectiveBench does not keep yet. Revisit if a skill's value cannot show against no skill
  by design (for example a skill that only changes style the model already follows).
- Status: active
- Origin: the agent's proposal after the 2026-10-29 D03 check, accepted by the maintainer in
  conversation on 2026-10-29.
