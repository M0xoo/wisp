# Homebrew formula for wisp-agents. Lives in the M0xoo/homebrew-tap repo as Formula/wisp-agents.rb:
#
#   brew tap m0xoo/tap
#   brew install wisp-agents
#
# Bump `url` and `sha256` with each npm release. The sha256 is that of the npm tarball:
#   curl -fsSL <url> | shasum -a 256
class WispAgents < Formula
  desc "Launch coding agents, skip the transcript, read the presentation"
  homepage "https://mokh.xyz/"
  url "https://registry.npmjs.org/wisp-agents/-/wisp-agents-0.15.0.tgz"
  sha256 "83376b9aca183f0b7e259411478fcfc1cc7a6675d12c99dfd5083d93c2566c90"
  license "MIT"

  depends_on "node"

  def install
    # --omit=optional skips the Electron desktop shell: Homebrew builds run without network
    # access, so its binary download would fail. Browser mode (`wisp --browser`) works without it.
    system "npm", "install", *std_npm_args, "--omit=optional"
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      The desktop app is not included with the Homebrew install. Use browser mode:
        wisp --browser     # then open http://localhost:4477
      For the desktop app, install from npm instead: npm install -g wisp-agents
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/wisp --version")
  end
end
