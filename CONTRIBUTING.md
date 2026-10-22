# Contributing

Issues are welcome: bug reports, rough edges, and ideas.

Pull requests are welcome too, but this is a one-person project, so **PRs are reviewed slowly**. For anything bigger than a small fix, please open an issue first so we can agree on the approach before you spend time on it.

Notes:
- There are no dependencies and I'd like to keep it that way.
- Run `npm test` before sending a PR (a protocol check that needs no Codex). If you touched job handling, also run `node smoke-test.mjs <scratch-dir> plan`: it needs a working, logged-in Codex CLI and uses a little of your Codex quota.
- Developed and tested on Windows 11. Reports and fixes for macOS and Linux are especially useful.
- By contributing you agree your contribution is licensed under the MIT license.

Built by [Xallindrome](https://xallindrome.co), an automation consultancy.
