import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { PlaygroundApp } from "./app.js";
import "./styles.css";

const root = document.querySelector("#root");
if (root === null) throw new Error("Playground root element is missing");

createRoot(root).render(
  <StrictMode>
    <PlaygroundApp />
  </StrictMode>,
);
