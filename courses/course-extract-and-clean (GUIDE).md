# Firefox Course Extraction and Cleanup Steps

1. **Configure Firefox:**

   * Open a new tab and go to `about:config`.
   * In the search bar, type `devtools.netmonitor.responseBodyLimit`.
   * Set the value of `devtools.netmonitor.responseBodyLimit` to `0`.

2. **Open Course Search Page:**

   * Go to [Butte College Course Search](https://selfservice.butte.edu/Student/Student/Courses/Search).

3. **Access Network Requests in DevTools:**

   * Open the **Developer Tools** (`F12` or right-click > Inspect).
   * Go to the **Network** tab.
   * Reload the page (press `Ctrl + R` or click the reload button).
   * Right-click the network request with the file column content labeled "PostSearchCriteria".
   * Click **Edit and Resend**.

4. **Modify Request Body:**

   * In the **Body** section, replace the existing content with the following single-line JSON:

     ```json
     {"pageNumber":1,"sortOn":"SectionName","sortDirection":"Ascending","quantityPerPage":10000,"searchResultsView":"CatalogListing"}
     ```

   * **Note:** The value of `"quantityPerPage"` is set to `10000`. You can increase this number if necessary.

5. **Send Request:**

   * Click **Send** to submit the request.

6. **Process the Response:**

   * Switch to the **Response** tab in the DevTools.
   * Copy the entire response and paste it to replace the contents of `courses.json`.

7. **Run the Python Script:**

   * Run `coursecleaner.py` from the same directory where the `courses.json` file is saved.
   * The cleaned courses list will be saved to `courses_cleaned.json`.
