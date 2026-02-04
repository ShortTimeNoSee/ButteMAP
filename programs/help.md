# Ellucian Scraper, How to Get Your Auth Credentials

**Note:** These instructions assume you are using Chrome. Steps are similar for Firefox.

1. **Log in to Butte Student Portal**

   - Go to [My Progress](https://selfservice.butte.edu/student/Planning/Programs/MyProgress).
   - Log in with your Butte College student account if prompted.

2. **Open DevTools and Find the Network Request**

   - Wait for the page to fully load.
   - Open Developer Tools (`F12` or right-click > Inspect).
   - Go to the **Network** tab.

3. **Trigger the Program Evaluation**

   - On the web page, click **"View a New Program"**.
   - Select a program (e.g., `2D Animation and Games-CERT` or `3D Mechanical Applications-CERT`; these load quickly).

4. **Copy the cURL Command**

   - In the Network tab, locate the new `ProgramEvaluation` request.
   - Right-click that request and choose **Copy > Copy as cURL**.

5. **Create the Auth File**

   - Open the `auth_config.txt` file in this directory.
   - Paste the entire cURL command you copied into this file and save it.
