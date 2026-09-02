const code = document.querySelector("#code");
const status = document.querySelector("#status");
const results = document.querySelector("#results");

document.querySelector("#run").addEventListener("click", async () => {
  status.textContent = "Running";
  const response = await fetch("/api/run", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({code: code.value}),
  });
  const report = await response.json();
  status.textContent = report.ok ? `${report.passed}/${report.total}` : report.error;
  results.textContent = JSON.stringify(report.results ?? [], null, 2);
});
