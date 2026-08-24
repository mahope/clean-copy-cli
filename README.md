# clean-copy (CLI)

Copy/paste text as **clean Markdown or plain text** — straight from your terminal. The same converter engine that powers the [Clean Copy browser extensions](https://github.com/mahope/clean-copy), packaged as a dependency-free Node.js CLI.

```
$ echo '<h1>Title</h1><p>Some <b>bold</b> text</p>' | clean-copy
# Title

Some **bold** text
```

## Install

### Homebrew (recommended)

```bash
brew tap mahope/clean-copy
brew install clean-copy
```

### From source

```bash
git clone https://github.com/mahope/clean-copy-cli.git
cd clean-copy-cli
sudo cp clean-copy.js /usr/local/bin/clean-copy
sudo cp clean_copy_core.js package.json /usr/local/lib/clean-copy/
```

Requires Node.js 16+. No dependencies, no build step.

## Usage

### CLI

```bash
clean-copy [options] [file ...]     # convert files, or stdin if no file given
clean-copy --url <url>              # fetch a page, extract its main content as Markdown

echo '<h1>Hi</h1>' | clean-copy                 # stdin -> stdout
pbpaste | clean-copy | pbcopy                   # macOS clipboard round-trip
clean-copy -u https://example.com/article.md    # web page -> readable Markdown
clean-copy -t notes.html                        # plain text instead of Markdown
clean-copy -c dirty.html                        # also copy result to clipboard
```

### GitHub Action

Convert any URL, local file, or raw HTML to clean Markdown directly in your workflow:

```yaml
- uses: mahope/clean-copy-cli@v1
  with:
    url: 'https://example.com/article'
  id: clean-copy

- name: Save the result
  run: echo "${{ steps.clean-copy.outputs.markdown }}" > article.md
```

Convert a local HTML file in the repo:

```yaml
- uses: mahope/clean-copy-cli@v1
  with:
    file: 'docs/draft.html'
    output_file: 'docs/draft.md'
```

Convert raw HTML from a CI step:

```yaml
- uses: mahope/clean-copy-cli@v1
  with:
    html: '<h1>Generated</h1><p>CI output</p>'
    mode: 'markdown'
```

| Input          | Default      | Description                                                    |
|----------------|--------------|----------------------------------------------------------------|
| `url`          | (optional)   | URL to fetch and convert (one of url/file/html required)       |
| `file`         | (optional)   | Path to a local HTML file in the repo to convert               |
| `html`         | (optional)   | Raw HTML string to convert directly                            |
| `mode`         | `markdown`   | Output format: `markdown` or `plain`                           |
| `output_file`  | (optional)   | Write the result to this file path for use in later steps      |

**Output:** `markdown` — the converted content.

**Example: weekly page snapshot as a PR**

```yaml
name: Weekly snapshot
on:
  schedule:
    - cron: '0 6 * * 1'  # Monday 06:00 UTC
jobs:
  snapshot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mahope/clean-copy-cli@v1
        with:
          url: 'https://example.com/changelog'
          output_file: 'docs/changelog-snapshot.md'
      - uses: peter-evans/create-pull-request@v6
        with:
          commit-message: 'chore: update changelog snapshot'
          title: 'Weekly changelog snapshot'
          branch: snapshot/changelog
```

### Options

| Flag | Effect |
|------|--------|
| `-t`, `--text` | plain text output instead of Markdown |
| `-u`, `--url URL` | fetch a web page and extract its main content |
| `-o`, `--out FILE` | write to FILE instead of stdout |
| `-c`, `--copy` | also copy the result to the system clipboard |
| `-q`, `--quiet` | no summary line on stderr |
| `-V`, `--version` | print version |

## What it converts

Headings (`#`–`######`), bold/italic, links, images, nested lists, ordered lists, code blocks with entity decoding (`&lt;` becomes `<`), blockquotes and tables → GitHub-flavored pipe tables. Smart quotes, em-dashes, zero-width characters and `&nbsp;` junk are normalized to clean ASCII.

The `--url` mode strips scripts, styles, nav/footer boilerplate and keeps the largest content block — good for articles, docs pages and blog posts.

## Privacy

No analytics, no tracking, no telemetry. The only network request ever made is the one *you* trigger with `--url`. Everything else runs locally.

## License

MIT