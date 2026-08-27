# Platform Code Source Manifest

- Current repository baseline: `773657818f1c4a13c28d4f71dda7bdc354f4717e`
- Legacy repository HEAD: `9582decbaab4df10af98f03d07c4a3299c926fdb`
- Legacy repository branch: `codex/home-dashboard-redesign`
- Legacy repository status captured: `2026-08-27`
- Legacy dirty worktree included: yes
- Fusion rule: current AI dashboard + legacy non-AI platform code
- Excluded from this phase: runtime data, old Codex tasks, Cloudflare deployment
- Current-only root `index.js`: preserved because the legacy repository has no root entrypoint

## Baseline Verification

- `npm run build`: passed
- Node startup tests: 8 passed
- Node API, service, and frontend tests: 276 passed
- Python tests: 25 passed using an isolated temporary environment

The legacy Downloads folder is a read-only source for this fusion. Runtime data,
reports, caches, credentials, and generated artifacts are not represented by the
code checksum manifest and are not copied in this phase.
