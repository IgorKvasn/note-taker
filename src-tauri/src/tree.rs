use std::fs;
use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TreeNode {
    pub name: String,
    /// Slash-separated, relative to the root -- never an absolute path.
    pub path: String,
    pub is_directory: bool,
    pub children: Vec<TreeNode>,
}

/// Pure `readdir` metadata for one root, recursive. Reads no file contents and
/// writes nothing, so calling it can never dirty the git working tree.
///
/// Non-`.md` files are dropped; directories are always kept regardless of
/// content, since an empty folder is still a valid create-target and a folder
/// that only contains subfolders of notes shouldn't disappear from the tree.
pub fn list_tree(root_path: &Path) -> Result<Vec<TreeNode>, String> {
    read_dir_sorted(root_path, "")
}

fn read_dir_sorted(absolute_dir: &Path, relative_dir: &str) -> Result<Vec<TreeNode>, String> {
    let entries = fs::read_dir(absolute_dir).map_err(|error| error.to_string())?;

    let mut directories = Vec::new();
    let mut notes = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();

        // `.git` and dotfiles/dot-directories are never notes or note folders,
        // matching the exclusions search already applies (§8 of the spec).
        if name.starts_with('.') {
            continue;
        }

        let file_type = entry.file_type().map_err(|error| error.to_string())?;

        // Symlinks are never followed, matching search's skip rule (§8 of the
        // spec) explicitly rather than relying on `file_type()`'s use of
        // `lstat` to make `is_dir()` false for a symlinked directory.
        if file_type.is_symlink() {
            continue;
        }

        let relative_path = if relative_dir.is_empty() {
            name.clone()
        } else {
            format!("{relative_dir}/{name}")
        };

        if file_type.is_dir() {
            let children = read_dir_sorted(&entry.path(), &relative_path)?;
            directories.push(TreeNode {
                name,
                path: relative_path,
                is_directory: true,
                children,
            });
        } else if file_type.is_file() && name.ends_with(".md") {
            notes.push(TreeNode {
                name,
                path: relative_path,
                is_directory: false,
                children: Vec::new(),
            });
        }
    }

    directories.sort_by(|a, b| a.name.cmp(&b.name));
    notes.sort_by(|a, b| a.name.cmp(&b.name));

    directories.extend(notes);
    Ok(directories)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_file(root: &Path, relative: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "").unwrap();
    }

    fn write_dir(root: &Path, relative: &str) {
        fs::create_dir_all(root.join(relative)).unwrap();
    }

    #[test]
    fn folders_sort_before_notes_within_a_directory() {
        let temp_dir = TempDir::new().unwrap();
        write_file(temp_dir.path(), "zebra.md");
        write_dir(temp_dir.path(), "apple-folder");

        let tree = list_tree(temp_dir.path()).unwrap();

        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].name, "apple-folder");
        assert!(tree[0].is_directory);
        assert_eq!(tree[1].name, "zebra.md");
        assert!(!tree[1].is_directory);
    }

    #[test]
    fn each_group_is_sorted_alphabetically() {
        let temp_dir = TempDir::new().unwrap();
        write_dir(temp_dir.path(), "zoo");
        write_dir(temp_dir.path(), "alpha");
        write_file(temp_dir.path(), "banana.md");
        write_file(temp_dir.path(), "aardvark.md");

        let tree = list_tree(temp_dir.path()).unwrap();
        let names: Vec<&str> = tree.iter().map(|node| node.name.as_str()).collect();

        assert_eq!(names, vec!["alpha", "zoo", "aardvark.md", "banana.md"]);
    }

    #[test]
    fn non_markdown_files_are_excluded() {
        let temp_dir = TempDir::new().unwrap();
        write_file(temp_dir.path(), "note.md");
        write_file(temp_dir.path(), "image.png");
        write_file(temp_dir.path(), "notes.txt");

        let tree = list_tree(temp_dir.path()).unwrap();

        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].name, "note.md");
    }

    #[test]
    fn dotfiles_and_git_directory_are_excluded() {
        let temp_dir = TempDir::new().unwrap();
        write_dir(temp_dir.path(), ".git");
        write_file(temp_dir.path(), ".git/HEAD");
        write_file(temp_dir.path(), ".hidden.md");
        write_file(temp_dir.path(), "visible.md");

        let tree = list_tree(temp_dir.path()).unwrap();

        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].name, "visible.md");
    }

    #[test]
    fn recurses_into_subdirectories_with_relative_paths() {
        let temp_dir = TempDir::new().unwrap();
        write_file(temp_dir.path(), "folder/nested.md");

        let tree = list_tree(temp_dir.path()).unwrap();

        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].name, "folder");
        assert_eq!(tree[0].path, "folder");
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].name, "nested.md");
        assert_eq!(tree[0].children[0].path, "folder/nested.md");
    }

    #[test]
    fn empty_directories_are_kept() {
        let temp_dir = TempDir::new().unwrap();
        write_dir(temp_dir.path(), "empty-folder");

        let tree = list_tree(temp_dir.path()).unwrap();

        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].name, "empty-folder");
        assert!(tree[0].children.is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn symlinked_directories_are_not_listed_or_recursed_into() {
        let temp_dir = TempDir::new().unwrap();
        let target_dir = TempDir::new().unwrap();
        write_file(target_dir.path(), "nested.md");
        write_file(temp_dir.path(), "visible.md");
        std::os::unix::fs::symlink(target_dir.path(), temp_dir.path().join("linked-folder"))
            .unwrap();

        let tree = list_tree(temp_dir.path()).unwrap();

        assert_eq!(tree.len(), 1, "the symlinked folder must not be listed");
        assert_eq!(tree[0].name, "visible.md");
        assert!(
            tree.iter().all(|node| node.name != "nested.md"),
            "a file only reachable through the symlink must never appear in the tree"
        );
    }

    #[test]
    #[cfg(unix)]
    fn symlinked_markdown_files_are_not_listed() {
        let temp_dir = TempDir::new().unwrap();
        write_file(temp_dir.path(), "real-target.md");
        write_file(temp_dir.path(), "visible.md");
        std::os::unix::fs::symlink(
            temp_dir.path().join("real-target.md"),
            temp_dir.path().join("link.md"),
        )
        .unwrap();

        let tree = list_tree(temp_dir.path()).unwrap();
        let names: Vec<&str> = tree.iter().map(|node| node.name.as_str()).collect();

        assert_eq!(names, vec!["real-target.md", "visible.md"]);
    }

    #[test]
    fn missing_root_returns_an_error_rather_than_panicking() {
        let result = list_tree(Path::new("/this/path/does/not/exist/hopefully"));
        assert!(result.is_err());
    }

    #[test]
    fn never_reads_file_contents_or_writes_to_the_root() {
        let temp_dir = TempDir::new().unwrap();
        write_file(temp_dir.path(), "note.md");

        let before = fs::read_dir(temp_dir.path()).unwrap().count();
        list_tree(temp_dir.path()).unwrap();
        let after = fs::read_dir(temp_dir.path()).unwrap().count();

        assert_eq!(before, after, "list_tree must not create or remove entries");
    }
}
