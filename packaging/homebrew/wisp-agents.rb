# Homebrew formula for wisp-agents. Lives in the M0xoo/homebrew-tap repo as Formula/wisp-agents.rb:
#
#   brew tap m0xoo/tap
#   brew install wisp-agents
#
# Bump `url` and `sha256` with each npm release. The sha256 is that of the npm tarball:
#   curl -fsSL <url> | shasum -a 256
class WispAgents < Formula
  desc "Launch coding agents, skip the transcript, read the presentation"
  homepage "https://trywisp.dev/"
  url "https://registry.npmjs.org/wisp-agents/-/wisp-agents-0.28.2.tgz"
  sha256 "f88412fb9c60351b3df20e0e8c53d869ff75e1d71d9e3c3b6794012d70246664"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]

    # Drop the optional Electron desktop shell. npm ignores --omit=optional on global installs, and
    # Electron fetches its ~300 MB binary into the keg on first `require`. Without it, `wisp` serves
    # the browser UI.
    electron = libexec/"lib/node_modules/wisp-agents/node_modules/electron"
    rm_r electron if electron.exist?
  end

  def caveats
    <<~EOS
      The desktop app is not included with the Homebrew install; `wisp` opens in your
      browser at http://localhost:4477.
      For the desktop app, install from npm instead: npm install -g wisp-agents
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/wisp --version")
  end
end
