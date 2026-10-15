# Runs only inside the dedicated local GitLab container. Its JSON result is
# captured by the setup script and stored with mode 0600, never logged.
user = User.find_by_username!("root")
token = user.personal_access_tokens.create!(
  name: "devintern-e2e-local",
  scopes: ["api"],
  expires_at: 30.days.from_now.to_date
)
puts "DEVINTERN_E2E_CREDENTIALS=" + {
  baseUrl: "http://127.0.0.1:8929",
  token: token.token
}.to_json
