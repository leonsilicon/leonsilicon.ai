package main

import (
	"os"

	"golang.org/x/mod/module"
	"golang.org/x/mod/zip"
)

func main() {
	f, err := os.Create(os.Args[3])
	if err != nil {
		panic(err)
	}
	defer f.Close()
	if err := zip.CreateFromDir(f, module.Version{Path: os.Args[1], Version: os.Args[2]}, os.Args[4]); err != nil {
		panic(err)
	}
}
