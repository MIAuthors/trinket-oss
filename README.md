# Trinket

An open source, browser-based coding environment designed for education.

Trinket lets students and educators write and run code directly in the browser, supporting multiple programming languages including Python, HTML, Java, R, and more.

## Features

- **Browser-based code editor** - Write and run code without installing anything
- **Multiple language support** - Python, HTML/CSS/JS, Java, R, GlowScript, and more
- **Embeddable trinkets** - Embed interactive code examples in any webpage
- **Course creation** - Build interactive coding courses and tutorials
- **Code sharing** - Share and remix code with others

## Prerequisites

- Docker and Docker Compose
- Node.js 18+ (for local development without Docker)
- MongoDB 5.0+
- Redis (optional - falls back to in-memory)

## Quick Start (Docker)

1. Clone the repository:
   ```bash
   git clone https://github.com/trinketapp/trinket-oss.git
   cd trinket-oss
   ```

2. Copy the example config and add your settings:
   ```bash
   cp config/local.example.yaml config/local.yaml
   ```

3. Start the services:
   ```bash
   docker-compose up
   ```

4. Visit http://localhost:3000 in your browser.

## Configuration

Configuration is managed through YAML files in the `config/` directory:

- `default.yaml` - Base configuration (committed to repo)
- `local.yaml` - Local overrides and secrets (not committed)
- `production.yaml` - Production overrides (not committed)

Copy `config/local.example.yaml` to `config/local.yaml` and fill in the required values.

### Required Configuration

| Setting | Description |
|---------|-------------|
| `app.plugins.session.cookieOptions.password` | Session cookie secret (min 32 chars) |

### Optional Integrations

| Setting | Description |
|---------|-------------|
| `app.mail.*` | SMTP settings for email (password reset, notifications) |
| `aws.*` | S3 storage for user-uploaded assets |
| `app.auth.google.*` | Google OAuth login |
| `app.recaptcha.*` | reCAPTCHA spam protection |

See [GETTING_STARTED.md](GETTING_STARTED.md). The full documentation map — LTI, deploy overlays, design records, compliance — is indexed at [docs/README.md](docs/README.md) for detailed setup of optional features.

## Development

### Running without Docker

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start MongoDB locally (Redis is optional)

3. Run the application:
   ```bash
   node app.js
   ```

### Running Tests

```bash
npm test
```

## Architecture

- **Backend**: Node.js with Hapi framework
- **Database**: MongoDB with Mongoose ODM
- **Cache/Sessions**: Redis (optional)
- **Frontend**: AngularJS 1.x
- **Code Execution**: Skulpt (Python in browser), server-side containers for other languages

## Contributing

Contributions are welcome! Please read our [Contributing Guidelines](CONTRIBUTING.md) before submitting a pull request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is released under CC0 1.0 Universal (Public Domain Dedication). See the [LICENSE](LICENSE) file for details.

## History

Trinket was originally created by Elliott Hauser and Brian Marks to make coding education accessible to everyone. It is now open source and maintained by the community.
