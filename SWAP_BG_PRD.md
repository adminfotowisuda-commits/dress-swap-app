# Product Requirements Document (PRD): Background Swap Tool

## 1. Introduction
### 1.1 Purpose
The purpose of this document is to specify requirements for the "Background Swap Tool" within the AI graduation dashboard (`fotowisuda.ai`). The tool automates seamless background replacement by orchestrating the Gemini 3.5 Flash API (for high-speed semantic intelligent prompt engineering) and Leonardo.ai API (for high-fidelity image composition).

### 1.2 Workflow Overview
1. **User Input:** Admin uploads **Image Reference 1** (The Graduate) and **Image Reference 2** (The Target Background), then selects the desired aspect ratio dimension.
2. **Gemini 3.5 Flash Processing:** The backend forwards Image Reference 2 and a constant system instruction to the Gemini API using the `gemini-3.5-flash` model. Gemini automatically analyzes the background aesthetics and outputs two text parameters: a `Positive Prompt` and a `Negative Prompt`.
3. **Leonardo.ai Execution:** The backend sends all variables (Image Reference 1, Image Reference 2, Positive Prompt, Negative Prompt, and selected dimensions) to Leonardo.ai using the locked structural parameters.
4. **Local Presentation:** The final generated image is downloaded, compressed for the dashboard view, and made available for full-resolution download back to `localhost`.

---

## 2. Functional Requirements

### 2.1 Core Features
* **Image Reference Upload:** Two input fields/areas to upload reference images:
    - **Image Reference 1:** The primary subject profile (graduate).
    - **Image Reference 2:** The target studio background canvas.
* **Dimension Selection:** Dropdown for predefined aspect ratios:
    - 2:3 (1696x2528)
    - 4:5 (1856x2304)
    - 4:3 (2400x1792)
* **Generate Action:** Button to trigger the background swap generation process via API orchestration call.
* **Dashboard View:** A display section to view the history, logs, and status of generated images on localhost.

### 2.2 Locked Parameter Configurations
To ensure consistent output quality, the following parameters are strictly hardcoded and not editable by the user in the UI:
* **Model:** Nano Banana 2
* **Prompt Enhance:** OFF
* **Style:** Dynamic, with `"style_ids": ["111dc692-d470-4eec-b791-3475abac4c46"]`
* **Number of Generations:** 1
* **Private Mode (Public):** OFF/False (ON Private)

---

## 3. Technical Requirements

### 3.1 API Integration
The application must integrate with the Leonardo.ai `/api/rest/v2/generations` endpoint using a POST request.

**Required Payload Structure:**
```json
{
  "model": "nano-banana-2",
  "public": false,
  "parameters": {
    "height": [Dynamic based on dropdown selection],
    "width": [Dynamic based on dropdown selection],
    "prompt_enhance": "OFF",
    "quantity": 1,
    "style_ids": ["111dc692-d470-4eec-b791-3475abac4c46"],
    "prompt": "[Dynamic Positive Prompt generated automatically by Gemini 3.5 Flash]",
    "negative_prompt": "[Dynamic Negative Prompt generated automatically by Gemini 3.5 Flash]",
    "guidances": {
      "image_reference": [
        { "image": { "id": "[Image Reference 1 S3 ID]", "type": "UPLOADED" }, "strength": "MID" },
        { "image": { "id": "[Image Reference 2 S3 ID]", "type": "UPLOADED" }, "strength": "MID" }
      ]
    }
  }
}