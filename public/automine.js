(() => {
  const WALLET_KEY = "bitlynes.wallet.v1";

  function getWallet() {
    try {
      return JSON.parse(localStorage.getItem(WALLET_KEY));
    } catch {
      return null;
    }
  }

  async function api(url, options) {
    const response = await fetch(url, options);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Request failed");
    return body;
  }

  const minerGrid = document.querySelector('section[data-page="/miner"] .grid');
  if (!minerGrid || document.querySelector("#autoMineCard")) return;

  const card = document.createElement("article");
  card.className = "card half";
  card.id = "autoMineCard";
  card.innerHTML = `
    <h2>AutoMine</h2>
    <p class="muted">Automatically mine a block whenever pending Lynes are waiting. It runs on this BitLynes node even if you leave the Miner page.</p>
    <label>Check queue every</label>
    <input id="autoMineInterval" type="number" min="1" max="60" step="1" value="2" />
    <div class="actions">
      <button class="btn good" id="autoMineToggle">Enable AutoMine</button>
    </div>
    <pre id="autoMineOut">Loading AutoMine status…</pre>
  `;
  minerGrid.appendChild(card);

  const button = card.querySelector("#autoMineToggle");
  const intervalInput = card.querySelector("#autoMineInterval");
  const output = card.querySelector("#autoMineOut");

  async function refresh() {
    try {
      const status = await api("/api/automine");
      intervalInput.value = Math.max(1, Math.round(status.intervalMs / 1000));
      button.textContent = status.enabled ? "Disable AutoMine" : "Enable AutoMine";
      button.classList.toggle("secondary", status.enabled);

      const lines = [
        `Status: ${status.enabled ? "ON" : "OFF"}`,
        `Miner: ${status.minerAddress || "Not set"}`,
        `Check interval: ${status.intervalMs / 1000}s`,
      ];

      if (status.busy) lines.push("Mining: in progress");
      if (status.lastMinedAt) lines.push(`Last mined: ${new Date(status.lastMinedAt).toLocaleTimeString()}`);
      if (status.lastBlock) {
        lines.push(`Last block: #${status.lastBlock.index}`);
        lines.push(`Lynes confirmed: ${status.lastBlock.transactions}`);
        lines.push(`Reward: ${status.lastBlock.reward} LYN`);
      }
      if (status.lastError) lines.push(`Error: ${status.lastError}`);

      output.textContent = lines.join("\n");
    } catch (error) {
      output.textContent = error.message;
    }
  }

  button.addEventListener("click", async () => {
    const wallet = getWallet();
    if (!wallet) {
      output.textContent = "Create an account first, then enable AutoMine.";
      return;
    }

    button.disabled = true;
    try {
      const current = await api("/api/automine");
      const intervalSeconds = Number(intervalInput.value);
      await api("/api/automine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: !current.enabled,
          minerAddress: wallet.address,
          intervalMs: intervalSeconds * 1000,
        }),
      });
      await refresh();
    } catch (error) {
      output.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  intervalInput.addEventListener("change", async () => {
    const current = await api("/api/automine").catch(() => null);
    const wallet = getWallet();
    if (!current?.enabled || !wallet) return;

    try {
      await api("/api/automine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          minerAddress: wallet.address,
          intervalMs: Number(intervalInput.value) * 1000,
        }),
      });
      await refresh();
    } catch (error) {
      output.textContent = error.message;
    }
  });

  refresh();
  setInterval(refresh, 2000);
})();
