# WeKan for Nextcloud

This repository packages WeKan as a Nextcloud AppAPI External App (ExApp).
One container runs the authenticated AppAPI gateway, WeKan and the bundled
wekan/FerretDB v1 SQLite database. HaRP carries HTTP and WebSocket/DDP traffic.
No MongoDB container, Docker socket mount, or external database is required.

The implementation has local HTTP/WebSocket and authentication tests. A real
Nextcloud/HaRP installation and a Docker image build still need validation
before an App Store production release.

## Requirements

- Nextcloud 32–35, AppAPI enabled, and a registered HaRP deploy daemon.
- The Nextcloud reverse proxy must forward `/exapps/` to HaRP, including
  WebSocket upgrades. Follow the [HaRP installation instructions](https://github.com/nextcloud/HaRP#readme).
- A published WeKan Docker version containing `server/nextcloud.js` and
  `/build/nextcloud-exapp-capability.json`. Existing images without that marker
  are deliberately rejected. Publish a new WeKan release with this integration
  before building its ExApp; changing metadata alone cannot retrofit old images.
- Persistent storage and enough RAM for WeKan and FerretDB together. Start
  validation with at least 2 GiB, then size for the actual workload.

## Build and install

After publishing the supporting WeKan release, from this repository:

```sh
# Replace VERSION with that published WeKan version (without v).
docker buildx build --platform linux/amd64 --load \
  --build-arg WEKAN_VERSION=VERSION \
  -t ghcr.io/wekan/wekan-exapp:vVERSION .
```

Set `appinfo/info.xml`'s app version to the normalized three-part version and
its image tag to `vVERSION`. The standalone `nextcloud.yml` workflow in
`wekan/wekan` performs these edits, tests this repository, and publishes amd64
and arm64 images. It never runs as part of `release-all.yml`.

For a pre-store test deployment, publish the image yourself, make the matching
`appinfo/info.xml` accessible to Nextcloud, then run as Nextcloud's web user:

```sh
php occ app_api:app:register wekan YOUR_HARP_DAEMON \
  --info-xml /absolute/path/to/appinfo/info.xml
```

If the deploy daemon uses an internal `NEXTCLOUD_URL` for callbacks, configure
`WEKAN_PUBLIC_URL` as the browser-visible URL, for example
`https://cloud.example/exapps/wekan/`. Otherwise it is derived from `NEXTCLOUD_URL`.
Include Nextcloud's subdirectory when it has one. Configure the usual Node
`NODE_EXTRA_CA_CERTS` environment/mount if the callback server uses a private CA;
never disable TLS verification.

Configure `NEXTCLOUD_ADMIN_USERS` in the app's deployment environment, for
example `["admin"]`, using exact Nextcloud user IDs. The default `[]` gives
nobody WeKan site-administrator rights. Ordinary users can still use boards.
The first visiting user never gains site-administrator privileges automatically.
When changing the list, restart/redeploy the container and reconnect clients.

Enabling the app registers **WeKan** in Nextcloud's navigation. That menu opens
`/exapps/wekan/` (under the Nextcloud subdirectory, if any). It uses Nextcloud's
existing authenticated session; no second WeKan password or OIDC setup is needed.
AppAPI routes require a logged-in Nextcloud user, including public WeKan boards.
Anonymous sharing outside Nextcloud is not enabled by this package.

## Authentication

The gateway validates `EX-APP-ID`, `EX-APP-VERSION` presence and the shared
`AUTHORIZATION-APP-API` secret using a constant-time comparison. It strips
incoming identity headers and signs the verified Nextcloud user ID with a fresh,
private key shared only with the child WeKan process. The key is never returned
to the browser. WeKan binds login and resume to these DDP connection headers.
Accounts are identified by the Nextcloud URL and exact user ID, never linked
by matching an existing username or email. Keep `NEXTCLOUD_URL` stable: changing
it creates a separate identity namespace. Disabled WeKan users stay disabled.
Attachment/avatar requests resolve the same verified identity.

`GET /heartbeat` is public. `POST /init` and `PUT /enabled` require the system
AppAPI identity (empty user ID plus the correct secret). Initialization reports
progress to AppAPI after WeKan is ready. Disabling closes WebSocket connections
and refuses app requests. Enabled state persists across container restarts.

## Storage and processes

AppAPI provides `APP_PERSISTENT_STORAGE`. Keep the volume and its backups private:
it also holds the FRP tunnel configuration and any injected TLS credentials. The launcher uses:

| Container path | Contents |
| --- | --- |
| `$APP_PERSISTENT_STORAGE/wekan/files/db` | FerretDB SQLite |
| `$APP_PERSISTENT_STORAGE/wekan/files/attachments` | Attachments |
| `$APP_PERSISTENT_STORAGE/wekan/files/avatars` | Avatars |
| `$APP_PERSISTENT_STORAGE/nextcloud-enabled.json` | AppAPI enabled state |

`WRITABLE_PATH` is `$APP_PERSISTENT_STORAGE/wekan`. Back up the entire persistent
volume with the container stopped, and test restoration. Do not remove the
AppAPI volume when upgrading the image. This is a new-install package; it does
not automatically import an existing UCS, MongoDB or standalone WeKan instance.

The launcher initializes directory ownership as root and then drops to the
WeKan UID/GID for all services. WeKan and FerretDB listen only on loopback ports.
HaRP FRP mode uses `/tmp/exapp.sock`; direct-connect mode uses `APP_HOST` and
`APP_PORT`. FRP, WeKan or FerretDB exiting stops the container. SIGTERM shuts down
all children with a bounded grace period. The database is the FerretDB binary
already shipped in the selected WeKan image, so its version stays with that image.

## Tests

```sh
mkdir -p .tools/tmp
TMPDIR="$PWD/.tools/tmp" node --test tests/*.test.mjs
```

Before production, test two Nextcloud users, configured admin privileges, denied
anonymous access, WebSocket reconnect, private boards, attachment upload/download,
avatars, disable/re-enable, container restart, upgrade with the same volume and
backup restoration. The WeKan repository also provides
`tests/playwright/specs/nextcloud.e2e.js` for a real signed-in browser session.

App Store signing keys, app registration, supported-version validation and
production publication remain maintainer tasks. See
[the release instructions](https://github.com/wekan/wekan/blob/main/docs/Design/Autoupdate/Nextcloud.md).
AI, Deck synchronization and file/calendar integrations are separate future work.

## Protocol references and licenses

- [AppAPI authentication](https://docs.nextcloud.com/server/latest/developer_manual/exapp_development/tech_details/Authentication.html)
- [AppAPI deployment](https://docs.nextcloud.com/server/latest/developer_manual/exapp_development/tech_details/Deployment.html)
- [AppAPI UI APIs](https://github.com/nextcloud/app_api/blob/main/appinfo/routes.php)
- [HaRP ExApp adaptation](https://github.com/nextcloud/HaRP#readme)

The wrapper is MIT licensed. The image includes WeKan and its dependencies under
their respective licenses; the bundled FRP client is
[Apache-2.0 licensed](https://github.com/fatedier/frp/blob/v0.61.1/LICENSE).

## Acceptance tests

Run `node --test tests/*.test.mjs` with `TMPDIR` pointing to the parent WeKan
checkout's `.tools/tmp`. Gateway tests cover authenticated HTTP/WebSockets,
readiness, rejected identities and persistent disable state, including an OCS
failure during deregistration. Runtime tests launch real child processes and
parse the FRP configuration independently; metadata guards check USER routes and
the image's capability/privilege boundaries.

The full native Nextcloud 32–35 browser matrix lives in the parent WeKan checkout:
[setup, coverage and remaining container checks](https://github.com/wekan/wekan/blob/main/docs/Platforms/FOSS/Container/Docker/Nextcloud/README.md#local-and-deployment-validation).
It uses real AppAPI/HaRP, WeKan and FerretDB under `.tools`, with UI uploads,
private-board isolation, lifecycle operations, source-built upgrades and full
volume restore. Published WeKan v12.32 needs the source transport bridge when
used as the baseline: SockJS's default header allowlist drops the custom signed
identity headers. New ExApp images must wrap a WeKan build containing that fix.

The gateway strips ordinary Authorization credentials as well as AppAPI secrets
before forwarding requests. Disabling is saved before menu deregistration, so an
unavailable Nextcloud endpoint cannot restore the previous enabled state after a
process restart.
