# LivingBot

LivingBot is an independent fork of [Rakazo](https://github.com/elie222/rakazo), built around persistent bots, private workspaces, and a self-hosted agent runtime.

## Updates

Upstream Rakazo releases are reference material only. Desktop automatic checks, downloads, quit-time installation, update reminders, and mobile over-the-air updates are disabled. The inherited desktop/mobile release workflows are disabled until LivingBot has its own release channels. No upstream package should replace a LivingBot installation.

Changes are developed, reviewed, tested, and installed explicitly from this project.

## Development

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The existing `@rakazo/*` workspace package names, protocol identifiers, application IDs, and data directories remain compatibility details. Renaming the product does not migrate, replace, or clean an existing database or Bot workspace.

For architectural and historical setup reference, see [the upstream documentation](docs/upstream-rakazo.md). Its upstream download, cloud, publishing, and update instructions do not describe LivingBot releases.

## License

LivingBot retains the original Apache-2.0 license and upstream attribution. See [LICENSE](LICENSE).
