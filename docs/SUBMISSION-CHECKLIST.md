# WebMCP Challenge submission checklist

Verified on 29 August 2026 against the authoritative challenge materials:

- [Official Devpost rules](https://webmcp.devpost.com/rules)
- [Official Devpost resources and FAQ](https://webmcp.devpost.com/resources)
- [OpenAI WebMCP Challenge page](https://openai.com/webmcp-challenge/)

If these sources conflict, the Official Rules control. Re-check them immediately
before submission because the rules state that they may be amended.

## Entrant and project eligibility

- [ ] Confirm every entrant is at least the age of majority where they reside.
- [ ] Confirm every entrant and organization satisfies the supported-country,
  sanctions, employment, judge-affiliation, and conflict-of-interest rules.
- [ ] Confirm the submission is original, owned by the entrant, and does not
  violate third-party intellectual-property or privacy rights.
- [ ] Confirm the project was created during the submission period or document
  the WebMCP work that meaningfully extended a pre-existing project after the
  submission period began.
- [x] Kenny does not claim production third-party SaaS integrations. Open-source
  dependencies remain subject to their own licences.

Eligibility depends on entrant facts that cannot be established from this
repository alone.

## Working project

- [x] Public live URL exists: <https://kenny-webmcp.vercel.app>.
- [x] The live URL responded successfully during the 29 August readiness audit.
- [ ] Re-test the final deployed build in ChatGPT's in-app browser.
- [ ] Re-test the final deployed build in Chrome 149+ with WebMCP enabled.
- [ ] Confirm the final live project functions exactly as shown in the submitted
  description and video.
- [ ] Keep the project available free of charge and without restriction through
  the end of judging.

## Public repository and licence

- [x] Public source repository: <https://github.com/justicekennymomoh/kenny>.
- [x] Repository contains the source, assets, lockfile, and instructions needed
  to install, run, build, and test the project.
- [x] Root `LICENSE` contains the MIT licence.
- [x] GitHub's public repository API detects the licence as `MIT`
  (`license.key: mit`, `spdx_id: MIT`), which makes the licence visible in
  GitHub's repository About area.
- [x] The source visibly calls `document.modelContext.registerTool(...)` through
  the WebMCP adapter.

## Required text description

- [x] Explain why the use case is a strong fit for WebMCP.
- [x] Explain how the project creates a better user experience.
- [x] Explain what people and agents can do together that was difficult before.
- [x] Briefly explain the six-tool WebMCP implementation.
- [x] State the application/agent/human capability boundary.
- [x] Provide a clear live judge walkthrough and local testing instructions.

The rewritten `README.md` supplies the repository version of this description.
The Devpost submission form still needs matching text.

## Required public YouTube video

- [ ] Upload the video to YouTube and make it publicly visible.
- [ ] Add the public YouTube URL to the Devpost submission form.
- [ ] Keep the video under three minutes; judges are not required to watch
  beyond three minutes.
- [ ] Include clear audio covering what was built and how WebMCP is used.
- [ ] Show the functioning project.
- [ ] Confirm the video contains no third-party trademarks, copyrighted music,
  or other third-party material unless permission exists.
- [ ] Record from a build whose visible copy uses "design software licence" and
  contains no visible reference to the replaced third-party product name.

## WebMCP verification

- [x] Exactly six stable WebMCP tools are declared.
- [x] There is no WebMCP approval tool.
- [x] README and test guide document the 4 preserved / 1 recovered / 0 repeated
  scenario invariant and exact attempts.
- [x] Deterministic Playwright coverage is explicitly distinguished from manual
  real-Chrome testing.
- [x] The repository does not claim ChatGPT in-app-browser verification without
  evidence.
- [x] Run and record the current working-tree automated verification: 12
  unit/adapter tests, 17 browser tests, and 29 total automated tests passed on
  29 August 2026.
- [ ] Run the final real-Chrome WebMCP smoke test after deployment.
- [ ] Run the final ChatGPT in-app-browser smoke test after deployment.

## AI assistance

- [x] The official resources say entrants may use Codex or another coding agent.
- [x] No AI-assistance disclosure requirement was found in the reviewed Official
  Rules, resources, or OpenAI challenge page.

Use of an agent does not transfer compliance responsibility away from the
entrant; the Official Rules remain the source of truth.

## Dates and submission freeze

- [ ] Submit before **3 September 2026 at 1:00pm Pacific Time**
  (**9:00pm GMT+1**).
- [ ] Complete every required field on the Devpost submission page.
- [ ] At the close of submissions, freeze the submitted Devpost entry,
  repository, and live site until judging ends/winners are announced, following
  the official rules and challenge FAQ.

The Official Rules list the judging period as 4 September 2026 at 10:00am PT
through 21 September 2026 at 5:00pm PT, with winners expected on or around
23 September 2026.
