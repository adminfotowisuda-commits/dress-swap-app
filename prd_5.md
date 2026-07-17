# Define the PRD content in Markdown format
prd_content = """# Product Requirements Document (PRD): Leonardo.ai-Inspired Dashboard

## 1. Introduction
### 1.1 Purpose
The purpose of this document is to outline the requirements for a web-based dashboard application designed to interface with the Leonardo.ai API. The application aims to simplify the generation of AI images by providing a streamlined, user-friendly interface that mimics the core functionalities of the Leonardo.ai platform while enforcing specific parameter constraints.

### 1.2 Target Audience
* End Users: Creators looking for a simplified interface to generate images using specific model settings.
* Developers: Technical team responsible for implementing the frontend and backend integration with the Leonardo.ai API.

---

## 2. Functional Requirements

### 2.1 Core Features
* **Prompt Input:** Text area for users to enter their generation prompt.
* **Image Reference Upload:** Two input fields/areas to upload reference images (Image Reference 1 & 2).
* **Dimension Selection:** Dropdown for predefined aspect ratios:
    * 2:3 (1696x2528)
    * 4:5 (1856x2304)
    * 4:3 (2400x1792)
* **Generate Action:** Button to trigger the generation process via API call.
* **Dashboard View:** A display section to view the history and status of generated images.

### 2.2 Locked Parameter Configurations
To ensure consistent output, the following parameters are hardcoded and not editable by the user:
* **Model:** Nano Banana 2
* **Prompt Enhance:** OFF
* **Style:** Dynamic
* **Number of Generations:** 1
* **Private Mode:** ON

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
    "height": [Dynamic based on selection],
    "width": [Dynamic based on selection],
    "prompt_enhance": "OFF",
    "quantity": 1,
    "style_ids": ["111dc692-d470-4eec-b791-3475abac4c46"],
    "prompt": "[User Input]",
    "guidances": {
      "image_reference": [
        { "image": { "id": "[ID]", "type": "UPLOADED" }, "strength": "MID" },
        { "image": { "id": "[ID]", "type": "UPLOADED" }, "strength": "MID" }
      ]
    }
  }
}