# UmiCode Smart Setup — Language Extension Map

Edit this table, then tell the AI to **"apply"** and it will update `umiSmartSetup.contribution.ts` automatically.

**Columns:**

- **Language ID** — VS Code language identifier (shown in the bottom status bar). Don't change these.
- **Display Name** — shown in the notification prompt
- **Extension ID** — `publisher.extensionName` from [open-vsx.org](https://open-vsx.org)
- **Compiler Binaries** — comma-separated binary names, checked in PATH
- **Compiler Install Hint** — shown when the binary is missing
- **Post Install Command** — VS Code command to run after install (optional, leave blank if none)

---

| Language ID  | Display Name   | Extension ID                            | Compiler Binaries          | Compiler Install Hint                                                               | Post Install Command       |
| ------------ | -------------- | --------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------- | -------------------------- |
| `python`     | Python         | `ms-python.python`                      | `python3, python`          | Install Python from python.org or via your package manager.                         | `python.createEnvironment` |
| `java`       | Java           | `redhat.java`                           | `javac, java`              | Install a JDK (e.g. Eclipse Temurin) from adoptium.net.                             |                            |
| `go`         | Go             | `golang.go`                             | `go`                       | Install Go from go.dev/dl.                                                          |                            |
| `rust`       | Rust           | `rust-lang.rust-analyzer`               | `rustc, cargo`             | Install Rust via rustup.rs.                                                         |                            |
| `c`          | C/C++          | `llvm-vs-code-extensions.vscode-clangd` | `gcc, clang, g++, clang++` | Install GCC via Homebrew: `brew install gcc` or Xcode: `xcode-select --install`.    |                            |
| `cpp`        | C/C++          | `llvm-vs-code-extensions.vscode-clangd` | `g++, clang++, gcc, clang` | Install GCC via Homebrew: `brew install gcc` or Xcode: `xcode-select --install`.    |                            |
| `csharp`     | C#             | `dotnetdev-kr-custom.csharp`            | `dotnet`                   | Install the .NET SDK from dot.net.                                                  |                            |
| `php`        | PHP            | `devsense.phptools-vscode`              | `php`                      | Install PHP from php.net or via Homebrew: `brew install php`.                       |                            |
| `ruby`       | Ruby           | `shopify.ruby-lsp`                      | `ruby`                     | Install Ruby via rbenv, rvm, or Homebrew: `brew install ruby`.                      |                            |
| `dart`       | Dart / Flutter | `dart-code.dart-code`                   | `dart, flutter`            | Install Flutter (includes Dart) from flutter.dev.                                   |                            |
| `swift`      | Swift          | `swiftlang.swift-vscode`                | `swift, swiftc`            | Install Swift via Xcode or swift.org.                                               |                            |
| `kotlin`     | Kotlin         | `JetBrains.kotlin-server`               | `kotlinc, kotlin`          | Install Kotlin via SDKMAN: `sdk install kotlin` or Homebrew: `brew install kotlin`. |                            |
| `dockerfile` | Docker         | `docker.docker`                         | `docker`                   | Install Docker Desktop from docker.com.                                             |                            |

---

## Add new languages here

Copy a row from the table above into this section and fill in the details.
Find extension IDs on [open-vsx.org](https://open-vsx.org).

| Language ID | Display Name | Extension ID | Compiler Binaries | Compiler Install Hint | Post Install Command |
| ----------- | ------------ | ------------ | ----------------- | --------------------- | -------------------- |
|             |              |              |                   |                       |                      |
