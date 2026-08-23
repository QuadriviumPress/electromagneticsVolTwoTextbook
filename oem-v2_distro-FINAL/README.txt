Source files for S.W. Ellingson (2020), Electromagnetics Vol. 2, VT Publishing.
https://doi.org/10.21061/electromagnetics-vol-2
This work is licensed under the Creative Commons Attribution-ShareAlike 4.0 International License. (CC BY-SA 4.0) 
To view a copy of the license, visit http://creativecommons.org/licenses/by-sa/4.0

Compiling the Project
=====================

To compile the Latex source into PDF from a Linux command line:
latex orbd.tex; makeindex orbd.idx; latex orbd.tex; latex orbd.tex; dvipdf orbd.dvi
exiftool -Title="Electromagnetics Vol. 2" -Author="Steven W. Ellingson" -Subject="" orbd.pdf

Of course this requires the Latex packages specified in orbd.tex, and assumes you use wish to use dvipdf to distill the result to a PDF.    

Processing of Fonts for Commercial Printing Services 
====================================================

If you intend to use a commercial printer or print-on-demand service, be aware of the following production issue.  These services may require fonts to be converted to outlines, even if the fonts are properly embedded.  If this pertains to you, consider the following issues. 
 
-- All images in this distribution are encapsulated postscript ("eps") in which fonts have already been converted to outlines.  If you generate new eps files, you should consider converting fonts to outlines in these files.  A simple bash script "convertEPStoEPS.sh" is provided in the "modules" subdirectory for this purpose.  This script uses Inkscape.  Simply put your new eps files in the modules subdirectory, cd to the modules directory, and run the script.  All eps files in the directory will be converted.

-- Convert fonts to outlines in the distilled PDF.  This can be done in a variety of ways.  An internet search will turn up the most current advice for the PDF distiller/editor you intend to use.


