# Security review

**Review date:** 2026-11-17  
**Scope:** GitHub Actions security-pipeline configuration and the npm dependency lockfile  
**Audit command:** `npm audit --package-lock-only --audit-level=high`

## Summary

The repository had no checked-in CodeQL, dependency-review, npm-audit, or secret-scanning workflows. The added workflows cover JavaScript/TypeScript and GitHub Actions static analysis, npm dependency auditing, and Gitleaks secret scanning.

The npm audit found **16 vulnerable dependency entries** in the lockfile: 1 critical, 11 high, and 4 moderate. These are development and packaging dependencies in the Electron build toolchain. No application-source vulnerability was confirmed by this workflow-configuration review.

## Dependency findings

| Severity | Affected packages | Finding |
|---|---|---|
| Critical | `tar` (transitively used by `@electron/rebuild`, `cacache`, and `node-gyp`) | The locked version is in the vulnerable range `<=7.5.20`. Advisories cover arbitrary file creation/overwrite, path traversal, file smuggling, denial of service, and related archive parsing issues: [GHSA-34x7-hfp2-rc4v](https://github.com/advisories/GHSA-34x7-hfp2-rc4v), [GHSA-8qq5-rm4j-mr97](https://github.com/advisories/GHSA-8qq5-rm4j-mr97), [GHSA-83g3-92jg-28cx](https://github.com/advisories/GHSA-83g3-92jg-28cx), [GHSA-qffp-2rhf-9h96](https://github.com/advisories/GHSA-qffp-2rhf-9h96), [GHSA-9ppj-qmqm-q256](https://github.com/advisories/GHSA-9ppj-qmqm-q256), [GHSA-r6q2-hw4h-h46w](https://github.com/advisories/GHSA-r6q2-hw4h-h46w), [GHSA-vmf3-w455-68vh](https://github.com/advisories/GHSA-vmf3-w455-68vh), [GHSA-w8wr-v893-vjvp](https://github.com/advisories/GHSA-w8wr-v893-vjvp), [GHSA-23hp-3jrh-7fpw](https://github.com/advisories/GHSA-23hp-3jrh-7fpw), [GHSA-8x88-c5mf-7j5w](https://github.com/advisories/GHSA-8x88-c5mf-7j5w), [GHSA-gvwx-54wh-qm9j](https://github.com/advisories/GHSA-gvwx-54wh-qm9j), and [GHSA-r292-9mhp-454m](https://github.com/advisories/GHSA-r292-9mhp-454m). |
| High | `@electron/rebuild`, `app-builder-lib`, `builder-util`, `builder-util-runtime`, `cacache`, `dmg-builder`, `electron-builder`, `electron-builder-squirrel-windows`, `electron-publish`, `make-fetch-happen`, and `node-gyp` | The build-tool dependency tree includes an AppImage search-path issue in `app-builder-lib` ([GHSA-7g7r-gx96-252g](https://github.com/advisories/GHSA-7g7r-gx96-252g)) and a cross-origin redirect credential leak in `builder-util-runtime` versions below `9.7.0` ([GHSA-p2f4-r6v6-j797](https://github.com/advisories/GHSA-p2f4-r6v6-j797)). The audit reports 11 high-severity vulnerable entries across the tree. |
| Moderate | `@electron/universal`, `config-file-ts`, `glob`, and `minimatch` | `glob` is affected by an AbortSignal cancellation bypass that can allow post-timeout filesystem traversal ([GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)); `minimatch` has a potential denial of service via globparts amplification ([GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)). The audit reports four moderate vulnerable entries across the tree. |

The audit reports that remediation is available by upgrading `electron-builder` to `26.18.0`, which is a major-version change from the currently declared `^25.1.0`. No dependency versions were changed as part of this review.

## Pipeline coverage

- **CodeQL:** JavaScript/TypeScript and GitHub Actions workflow analysis on pull requests to `main`, pushes to `main`, and a weekly schedule.
- **Dependency security:** npm lockfile audit on pull requests, pushes to `main`, and weekly. The audit fails on high- and critical-severity findings.
- **Secret scanning:** Gitleaks scans repository history on pull requests, pushes, and a weekly schedule.

GitHub Dependency Review is not enabled because this repository's dependency graph is disabled. The npm audit workflow provides dependency vulnerability checks without that repository setting.

## Validation

- `npm test`: 174 tests passed.
- Workflow YAML files parsed successfully.
- `npm audit --package-lock-only --audit-level=high`: failed as intended on the findings above.
