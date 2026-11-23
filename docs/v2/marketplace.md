# Bot and ability packages

The capability center can browse a GitHub catalog, inspect a public package,
review its exact contents and install that revision. It can share selected
local method documents and prepare GitHub upload and catalog-inclusion forms.
Actual public publication, maintainer review and the complete author journey
remain unverified. The current format does not yet carry scripts or binary
assets; these limitations remain visible requirements.

The `livingbot-package-v1` format includes `id`, `kind` (`bot` or `ability`),
`name`, `description`, `version`, `license`, `author`, `permissions` and `files`.
Each file has a relative `path` and UTF-8 `text`. Versions use semantic version
syntax. A Bot requires `SOUL.md`; abilities include
`skills/<name>/SKILL.md` and optional Markdown/text references. Each method
declares its exact name and description in frontmatter. Packages are currently
limited to reviewed identity and method documents; scripts, hooks, credentials,
memory and conversation files are rejected. Permission descriptions are author
declarations, not automatic tool or operating-system grants.

GitHub branches resolve once to a commit. Tree traversal rejects links and
executable files, and downloaded bytes must match their Git blob hash. A stored
preview binds installation to its reviewed digest; installation never rereads a
moving branch. A Bot package creates an independent native agent. An ability
package targets a selected existing Bot. Installed method names include the
immutable package digest so different versions retain separate files.

Updating requires the installation's observed digest and a newly reviewed
package from the same repository, path, package identity and kind. It retains
the agent, conversations, private memory and original method files. New methods
are enabled and superseded methods disabled through native configuration.
Updating public identity is a separate explicit choice: the original identity
is backed up and verified before replacement. A local identity edit produces a
conflict; the user can choose to retain it. An incomplete update retains its
receipt and files, can resume after restart, and blocks only that Bot's new
task admission until resolved.

Package revocation disables its owned native methods. It retains the Bot,
identity, memories, conversations and files. An identical method still owned by
another active installation remains enabled for that owner. Re-enabling uses
the same installation and agent. Access changes affect future task admission;
they do not claim to stop work that has already started.

Sharing lists metadata only within the selected Bot's local methods directory.
It reads only explicitly selected method files. Private memory, conversations,
account settings and another Bot's methods are not included. Unsupported files,
links and missing method entry files are reported rather than silently omitted.
Authors enter public identity separately and can choose a methods-only package.
This does not infer which personal text inside a selected document is safe to
publish: the complete selected contents must be reviewed.

The reviewed share is stored with a digest. Downloading, preparing an upload
or reopening the share uses those exact bytes, even if the source method has
changed. Switching the selected Bot resets the sharing form and its selection.
The author can download the package, choose an existing GitHub repository and
branch, and open its upload page. The upload handoff prepares the repository,
branch and filename for the package-inspection form when the author returns.
No GitHub account token is collected by this workflow.

Catalogs use `livingbot-market-v1`, with `name` and a `packages` array. Each entry
contains `id`, `name`, `description`, `kind`, `repository`, `commit`, `path` and
`tags`. Entries require an exact commit rather than a moving branch. For example:

```json
{
  "format": "livingbot-market-v1",
  "name": "Example market",
  "packages": [{
    "id": "example-researcher",
    "name": "Example researcher",
    "description": "Review selected sources.",
    "kind": "bot",
    "repository": "example/public-bots",
    "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "path": "livingbot.json",
    "tags": ["research"]
  }]
}
```

Catalogs are read through the same immutable Git object adapter as packages.
Stored catalogs can be reopened after restart and searched locally. Selecting an
entry resolves its exact revision and checks that the package identity and kind
match before showing the ordinary content-review and installation controls.

After inspecting a hosted package, an author can prepare a catalog-inclusion
request. Its downloaded entry contains the exact public package source. The
GitHub issue form includes that source and the observed catalog revision; the
author submits it there and the catalog maintainer reviews inclusion. The app
records only `prepared`, never `published` or `accepted`. These forms do not
automatically upload files or send messages. Public catalog/package reads
require no GitHub credential.
