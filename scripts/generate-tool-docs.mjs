import fs from 'fs';
import path from 'path';

const packagesDir = 'packages';
const docsToolsDir = 'docs/tools';

const packages = fs.readdirSync(packagesDir).filter(p => fs.statSync(path.join(packagesDir, p)).isDirectory());

const phaseMap = {
  'behavior-diff': 'P6 Integrate',
  'cli': 'Shared foundation',
  'coldstart': 'P2 Decompose',
  'consensus-fix': 'P4 Build',
  'core': 'Shared foundation',
  'flail-detector': 'P4 Build',
  'gate-fuzzing': 'Continuous calibration',
  'gate-manifest': 'P5/P6 Prosecute/Integrate',
  'hollow-test': 'P3/P5 Rail/Prosecute',
  'lesson-foundry': 'P7 Distill',
  'merge-forecast': 'P2 Decompose',
  'model-ratchet': 'Continuous calibration',
  'model-router': 'P2 Decompose',
  'parallax': 'P1/D3 Spec shaping',
  'preflight': 'P0 Triage / Preflight',
  'premortem': 'P1 Interrogate',
  'prosecute': 'P5 Prosecute',
  'rails-guard': 'P3 Rail',
  'rejection-mining': 'P7 Distill',
  'review-calibration': 'P5 Prosecute / Continuous calibration',
  'runner': 'Execution supervision',
  'skill-rot': 'P7 Distill',
  'spec-lint': 'P1 Interrogate'
};

const mermaidDiagrams = {
  'P0 Triage / Preflight': `\`\`\`mermaid
flowchart TD
    Req([Request]) --> P0{"P0 Triage"}
    P0 --> P1["P1 Interrogate"]
    P0 -.-> Preflight["Preflight (Baseline check)"]
    style Preflight fill:#f9f,stroke:#333,stroke-width:2px
\`\`\``,
  'P1 Interrogate': `\`\`\`mermaid
flowchart TD
    P0["P0 Triage"] --> P1["P1 Interrogate"]
    P1 --> G1{{"GATE: Spec Approved"}}
    G1 --> P2["P2 Decompose"]
    style P1 fill:#f9f,stroke:#333,stroke-width:2px
\`\`\``,
  'P1/D3 Spec shaping': `\`\`\`mermaid
flowchart TD
    P0["P0 Triage"] --> P1["P1 Interrogate / Parallax"]
    P1 --> G1{{"GATE: Spec Approved"}}
    G1 --> P2["P2 Decompose"]
    style P1 fill:#f9f,stroke:#333,stroke-width:2px
\`\`\``,
  'P2 Decompose': `\`\`\`mermaid
flowchart TD
    G1{{"GATE: Spec Approved"}} --> P2["P2 Decompose"]
    P2 --> G2{{"GATE: Coldstart Pass"}}
    G2 --> P3["P3 Rail"]
    style P2 fill:#f9f,stroke:#333,stroke-width:2px
\`\`\``,
  'P3 Rail': `\`\`\`mermaid
flowchart TD
    G2{{"GATE: Coldstart Pass"}} --> P3["P3 Rail"]
    P3 --> G3{{"GATE: Rails Frozen"}}
    G3 --> P4["P4 Build"]
    style P3 fill:#f9f,stroke:#333,stroke-width:2px
\`\`\``,
  'P4 Build': `\`\`\`mermaid
flowchart TD
    G3{{"GATE: Rails Frozen"}} --> P4["P4 Build"]
    P4 --> G4{{"GATE: Build Pass"}}
    G4 --> P5["P5 Prosecute"]
    style P4 fill:#f9f,stroke:#333,stroke-width:2px
\`\`\``,
  'P5 Prosecute': `\`\`\`mermaid
flowchart TD
    G4{{"GATE: Build Pass"}} --> P5["P5 Prosecute"]
    P5 --> G5{{"GATE: Zero Findings"}}
    G5 --> P6["P6 Integrate"]
    style P5 fill:#f9f,stroke:#333,stroke-width:2px
\`\`\``,
  'P6 Integrate': `\`\`\`mermaid
flowchart TD
    G5{{"GATE: Zero Findings"}} --> P6["P6 Integrate"]
    P6 --> G6{{"GATE: Human Acceptance"}}
    G6 --> P7["P7 Distill"]
    style P6 fill:#f9f,stroke:#333,stroke-width:2px
\`\`\``,
  'P5/P6 Prosecute/Integrate': `\`\`\`mermaid
flowchart TD
    P4["P4 Build"] --> P5["P5 Prosecute"]
    P5 --> P6["P6 Integrate"]
    style P5 fill:#f9f,stroke:#333,stroke-width:2px
    style P6 fill:#f9f,stroke:#333,stroke-width:2px
\`\`\``,
  'P3/P5 Rail/Prosecute': `\`\`\`mermaid
flowchart TD
    P3["P3 Rail"] --> P4["P4 Build"]
    P4 --> P5["P5 Prosecute"]
    style P3 fill:#f9f,stroke:#333,stroke-width:2px
    style P5 fill:#f9f,stroke:#333,stroke-width:2px
\`\`\``,
  'P7 Distill': `\`\`\`mermaid
flowchart TD
    G6{{"GATE: Human Acceptance"}} --> P7["P7 Distill"]
    P7 -.-> P1["P1 Interrogate (Feedback)"]
    style P7 fill:#f9f,stroke:#333,stroke-width:2px
\`\`\``,
  'Continuous calibration': `\`\`\`mermaid
flowchart TD
    P7["P7 Distill"] --> Calib["Continuous Calibration"]
    Calib -.-> P5["P5 Prosecute (Update Reviewers)"]
    style Calib fill:#f9f,stroke:#333,stroke-width:2px
\`\`\``,
  'Execution supervision': `\`\`\`mermaid
flowchart TD
    P0["P0 Triage"] --> P7["P7 Distill"]
    Super["Execution Supervision (Runner)"] -.-> P0
    Super -.-> P7
    style Super fill:#f9f,stroke:#333,stroke-width:2px
\`\`\``,
  'Shared foundation': `\`\`\`mermaid
flowchart TD
    Found["Shared Foundation (Core/CLI)"] -.-> P1["P1 Interrogate"]
    Found -.-> P2["P2 Decompose"]
    Found -.-> P3["P3 Rail"]
    Found -.-> P4["P4 Build"]
    Found -.-> P5["P5 Prosecute"]
    Found -.-> P6["P6 Integrate"]
    Found -.-> P7["P7 Distill"]
    style Found fill:#f9f,stroke:#333,stroke-width:2px
\`\`\``,
  'P5 Prosecute / Continuous calibration': `\`\`\`mermaid
flowchart TD
    P4["P4 Build"] --> P5["P5 Prosecute"]
    P7["P7 Distill"] --> Calib["Continuous Calibration"]
    Calib -.-> P5
    style P5 fill:#f9f,stroke:#333,stroke-width:2px
    style Calib fill:#f9f,stroke:#333,stroke-width:2px
\`\`\``
};

for (const pkg of packages) {
  const readmePath = path.join(packagesDir, pkg, 'README.md');
  if (!fs.existsSync(readmePath)) continue;

  const content = fs.readFileSync(readmePath, 'utf-8');
  const phase = phaseMap[pkg] || 'Unknown';
  const diagram = mermaidDiagrams[phase] || '';

  const frontmatter = `---
title: ${pkg}
description: Documentation for the ${pkg} tool in the ADLC toolkit.
---

`;

  let newContent = frontmatter + content;

  // Insert diagram under ADLC phase or at the top if ADLC phase section doesn't exist
  if (diagram) {
    const phaseMarker = '**ADLC phase:**';
    const otherMarker = '**ADLC phase:';
    if (newContent.includes(phaseMarker)) {
        newContent = newContent.replace(phaseMarker, `**ADLC phase:** ${phase}\n\n### ADLC Lifecycle Context\n\n${diagram}\n\n`);
    } else if (newContent.includes(otherMarker)) {
        newContent = newContent.replace(/\*\*ADLC phase:.*?\*\*/i, `**ADLC phase: ${phase}**\n\n### ADLC Lifecycle Context\n\n${diagram}\n\n`);
    } else {
        newContent = newContent.replace(/# [^\n]+/, `$& \n\n**ADLC Phase:** ${phase}\n\n### ADLC Lifecycle Context\n\n${diagram}\n\n`);
    }
  }

  const outputPath = path.join(docsToolsDir, `${pkg}.md`);
  fs.writeFileSync(outputPath, newContent);
  console.log(`Generated ${outputPath}`);
}
