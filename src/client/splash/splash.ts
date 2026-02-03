import { context, requestExpandedMode } from "@devvit/web/client";

const startButton = document.getElementById(
  "start-button"
) as HTMLButtonElement;

startButton.addEventListener("click", (e) => {
  requestExpandedMode(e, "game");
});

const greetingElement = document.getElementById("greeting") as HTMLParagraphElement;

function init() {
  if (greetingElement) {
    greetingElement.textContent = `Hello, ${context.username ?? "player"}!`;
  }
}

init();