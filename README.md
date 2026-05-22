# @mgreten/aws/s3-site-deploy

Swamp extension model for deploying a static site directory to AWS S3. Walks
the repo root, uploads new or changed files, and deletes stale S3 objects.
Unchanged files are skipped via MD5/ETag comparison, so deploys are fast and
incremental.

## Installation

```bash
swamp extension pull @mgreten/aws/s3-site-deploy
```

## Usage

Add the model to your swamp repo:

```bash
swamp model add site-deploy @mgreten/aws/s3-site-deploy
```

Set the required global arguments on the model. Store credentials in a vault:

```bash
swamp model set site-deploy bucket my-bucket-name
swamp model set site-deploy region us-west-2
swamp model set site-deploy accessKeyId '${{ vault.get(my-vault, AWS_ACCESS_KEY_ID) }}'
swamp model set site-deploy secretAccessKey '${{ vault.get(my-vault, AWS_SECRET_ACCESS_KEY) }}'
```

To exclude additional top-level paths from the deployment (e.g. build tooling,
docs, CI config):

```bash
swamp model set site-deploy skipPaths '["CLAUDE.md", "Makefile", "docs"]'
```

Then deploy:

```bash
swamp model method run site-deploy deploy
```

## Global Arguments

| Argument          | Required | Default      | Description                                         |
| ----------------- | -------- | ------------ | --------------------------------------------------- |
| `bucket`          | Yes      | —            | S3 bucket name                                      |
| `region`          | No       | `us-east-1`  | AWS region                                          |
| `accessKeyId`     | No       | —            | AWS access key ID (use a vault expression)          |
| `secretAccessKey` | No       | —            | AWS secret access key (use a vault expression)      |
| `skipPaths`       | No       | `[]`         | Additional top-level paths to exclude from upload   |

Paths starting with `.` or `_` are always excluded, as are swamp-managed
directories (`extensions`, `models`, `workflows`, `vaults`).

If `accessKeyId` and `secretAccessKey` are both empty, the AWS SDK falls back to
its default credential chain (environment variables, instance profile, etc.).

## Cache Control

- HTML files: `no-cache`
- All other files: `public, max-age=86400`

## Resources

| Resource     | Description              |
| ------------ | ------------------------ |
| `deployment` | Metadata from last deploy (files uploaded, skipped, deleted, timestamp) |

## License

MIT
