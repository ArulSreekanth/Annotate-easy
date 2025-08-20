# Image Annotation Tool

This repository contains an image annotation tool with both frontend and backend components, designed to allow users to upload images, annotate them with polygons, and export annotations in JSON or COCO formats.

## Overview

- **Frontend**: Built with React and React-Konva for interactive canvas-based annotation.
- **Backend**: Handles image processing and segmentation using a Python-based.

## Features

- Upload and display images for annotation.
- Draw points to define regions, with automatic polygon detection using SAM (Segment Anything Model).
- Edit and relabel annotations with undo/redo functionality.
- Export annotations in JSON or COCO format.
- Responsive design with zoom and pan capabilities.

## Directory Structure

- `backend/`: Contains Python scripts and configuration for the backend server.
  - `app.py`: Main backend application.
  - `config.js`: JavaScript configuration file.
  - `backend.sh`: Shell script for backend operations.
- `frontend/`: Contains the React-based frontend application
  - `public/`: Static assets.
    - `front_image.png`: Default background image.
    - `index.html`: Main HTML file.
  - `src/`: Source files.
    - `assets/`: Additional image assets.
    - `App.jsx`: Main React component.
    - `index.js`: Entry point for the React app.
  - `babelrc`: Babel configuration.
  - `package-lock.json`: Lock file for dependencies.
  - `package.json`: Project dependencies and scripts.
  - `postcss.config.js`: PostCSS configuration.
  - `tailwind.config.js`: Tailwind CSS configuration.
  - `webpack.config.js`: Webpack configuration.

## Installation

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd <repository-folder>
   ```

2. **Install backend dependencies**:
   - create a folder for model weights.
     ```bash
      mkdir checkpoints

      cd checkpoints

   - Download model weights
     ``` bash
     wget https://dl.fbaipublicfiles.com/ segment_anything/sam_vit_h_4b8939.pth
     ```  
   - Navigate to the `backend/` directory 
   - Run:
     ```bash
     python3 -m venv venv

     source /venv/bin/activate

     pip install -r requirements.txt
     ```

3. **Install frontend dependencies**:
   - Navigate to the `frontend/` directory.
   - Run:
      ```bash
     npm install
     ```

4. **Configure the backend**:
   - Update `config.js` and `App.jsx` with the appropriate API base URL (e.g `http://localhost:8000` ).

5. **Run the application(testing)**:
   - Start the backend server 
   - Navigate to the backend folder and source the venv if created.
     ```bash
     cd backend && source /venv/bin/activate
     ```
      ```bash
     uvicorn app:app --host 0.0.0.0 --port 8000
     ```
   - Start the frontend: Navigate to the frontend folder 
     ```bash
     npm start
     ```

 
## *TO HOST it publically*
1. **Backend** 
     - Signup to ngrok and install the ngrok agent to your device. 
     - Create tmux session (To run continously)
       ``` bash
        tmux new -s <session_name>

        source ../ven/bin/activate

        source ./backend.sh
       ```
    - To detach from the session (CTRL + b , then select d)
    - To attach to exixting tmux session
      ``` bash
      tmux attach -t <session_name>
      ```
2. **Frontend**
    - Login to netlify create and account for deploy.
    - Create dist folder to upload in netlify
      ```bash
      npm run build 
      ```
    - Upload build folder to netlify , you will get the link. share to others.


## Usage

1. **Login**: Enter the password to access the annotation interface.
2. **Upload Image**: Click "Upload Image" to select and upload an image.
3. **Annotate**:
   - Switch to "Select the Object" mode to add points.
   - Click "Detect Polygon" to generate a polygon based on points.
   - Switch to "Edit" mode to adjust or relabel polygons.
   - use undo/redo options if necessary 
4. **Export**: Use "Save JSON" or "Save COCO" to export annotations.

## Contributing

Feel free to fork this repository and submit pull requests. Please ensure your code follows the existing style and includes appropriate tests.


## License

This project is licensed under the [MIT License](LICENSE). This means you are free to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the software, provided that you include the original copyright notice and this license in all copies or substantial portions of the software. 

The full text of the license is available in the [LICENSE](LICENSE) file in this repository. By contributing to this project, you agree that your contributions will also be licensed under the MIT License.

For more details on what the MIT License allows, see [this summary](https://opensource.org/licenses/MIT).
