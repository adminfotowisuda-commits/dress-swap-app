# Defining the PRD for the Admin Gallery feature in Markdown format
gallery_prd_content = """# Product Requirements Document (PRD): Admin Gallery Feature

## 1. Introduction
### 1.1 Purpose
The purpose of this document is to define the requirements for adding an "Admin Gallery" feature to the existing AI image generation dashboard. This feature allows administrators to view, manage, and audit past generations, providing a visual side-by-side comparison of the final generated images alongside their original input reference assets.

### 1.2 Target Audience
* Admin / Creators: To review quality control and track historical asset generations.
* Developers: Technical team implementing local file compression, image storage optimization, and database schemas.

---

## 2. Functional Requirements

### 2.1 Storage & Image Management Logic
To ensure fast gallery performance on `localhost` without overloading client bandwidth, the backend must implement the following pipeline:
* **Generated Cover Compression:** Upon a successful generation completion from Leonardo.ai, the backend downloads the high-resolution source image, resizes/compresses it into a optimized "Cover/Thumbnail" version, and saves it locally.
* **Reference Asset Preservation:** When an asset is generated using references, copies of *Image Reference 1* and *Image Reference 2* (if present) are captured from the upload workflow and stored permanently in a localized project folder.
* **Metadata Association:** Every generation record must link the generated cover image, reference 1 path, reference 2 path, prompt, dimensions, and creation date into a single structured entry.

### 2.2 Core UI Features (Gallery Board)
* **Visual Card Frames:** A clean grid layout displaying cards of past generations.
* **Component Framework Layout:** Inside each generated photo frame card, the UI must explicitly display:
    * The main optimized Generated Image (Large).
    * Embedded preview badges/thumbnails for **Image Reference 1** and **Image Reference 2** (if active) placed dynamically in a sub-section of the card frame for comparison.
* **Quick Meta-Data Access:** Hovering or clicking a card displays the prompt used, aspect ratio metadata, and creation timestamp.
* **Local Operations:** Ability to download the full-res file directly via the local server proxy or delete the entry from the gallery record.

---

## 3. Technical & Data Specifications

### 3.1 Directory Asset Architecture
Local file storage structure to be created within the Node.js environment:
```text
/public/uploads/
  ├── thumbnails/    <-- Contains compressed cover outputs
  └── references/    <-- Contains captured original input references